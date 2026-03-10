//! Fulfill deposit instruction: compute shares for a pending deposit request.
//!
//! The operator calls this after reviewing the deposit. Supports dual pricing:
//! oracle-priced (operator provides price) or vault-priced (svs-math conversion).
//! No token movement occurs here — shares are minted at claim time.

use anchor_lang::prelude::*;

use crate::{
    constants::DEPOSIT_REQUEST_SEED,
    error::VaultError,
    events::DepositFulfilled,
    state::{AsyncVault, DepositRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct FulfillDeposit<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        constraint = vault.operator == operator.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
        constraint = deposit_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<FulfillDeposit>, oracle_price: Option<u64>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let deposit_request = &ctx.accounts.deposit_request;
    let clock = &ctx.accounts.clock;

    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let owner_key = deposit_request.owner;
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &owner_key, &[])?;
    }

    let shares = if let Some(price) = oracle_price {
        svs_oracle::validate_price(price).map_err(|e| match e {
            svs_oracle::OracleError::InvalidPrice => VaultError::ZeroAmount,
            svs_oracle::OracleError::StalePrice => VaultError::OracleStale,
            svs_oracle::OracleError::PriceDeviationExceeded => VaultError::OracleDeviationExceeded,
            svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
            _ => VaultError::MathOverflow,
        })?;

        if vault.total_assets > 0 || vault.total_shares > 0 {
            let vault_price = crate::math::convert_to_assets(
                svs_oracle::PRICE_SCALE,
                vault.total_assets,
                vault.total_shares,
                vault.decimals_offset,
                crate::math::Rounding::Floor,
            )?;
            svs_oracle::validate_deviation(price, vault_price, vault.max_deviation_bps).map_err(
                |e| match e {
                    svs_oracle::OracleError::PriceDeviationExceeded => {
                        VaultError::OracleDeviationExceeded
                    }
                    svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
                    _ => VaultError::MathOverflow,
                },
            )?;
        }

        svs_oracle::assets_to_shares(deposit_request.assets_locked, price).map_err(|e| match e {
            svs_oracle::OracleError::InvalidPrice => VaultError::ZeroAmount,
            svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
            _ => VaultError::MathOverflow,
        })?
    } else {
        crate::math::convert_to_shares(
            deposit_request.assets_locked,
            vault.total_assets,
            vault.total_shares,
            vault.decimals_offset,
            crate::math::Rounding::Floor,
        )?
    };

    #[cfg(feature = "modules")]
    let net_shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };
    #[cfg(not(feature = "modules"))]
    let net_shares = shares;

    let deposit_request = &mut ctx.accounts.deposit_request;
    deposit_request.shares_claimable = net_shares;
    deposit_request.status = RequestStatus::Fulfilled;
    deposit_request.fulfilled_at = clock.unix_timestamp;

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_add(deposit_request.assets_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_add(net_shares)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_pending_deposits = vault
        .total_pending_deposits
        .checked_sub(deposit_request.assets_locked)
        .ok_or(VaultError::MathOverflow)?;

    emit!(DepositFulfilled {
        vault: vault.key(),
        owner: deposit_request.owner,
        shares: net_shares,
        assets: deposit_request.assets_locked,
    });

    Ok(())
}
