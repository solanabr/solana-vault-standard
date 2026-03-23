//! Fulfill deposit instruction: compute shares for a pending deposit request.
//!
//! The operator calls this after reviewing the deposit. Supports dual pricing:
//! oracle-priced (operator provides price) or vault-priced (svs-math conversion).
//! No token movement occurs here — shares are minted at claim time.

use anchor_lang::prelude::*;

use crate::{
    constants::{DEPOSIT_REQUEST_SEED, OPERATOR_APPROVAL_SEED},
    error::VaultError,
    events::DepositFulfilled,
    state::{AsyncVault, DepositRequest, OperatorApproval, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct FulfillDeposit<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
        constraint = deposit_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    pub operator_approval: Option<Account<'info, OperatorApproval>>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<FulfillDeposit>, oracle_price: Option<u64>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let deposit_request = &ctx.accounts.deposit_request;
    let clock = &ctx.accounts.clock;

    let is_vault_operator = vault.operator == ctx.accounts.operator.key();
    if !is_vault_operator {
        let approval = ctx
            .accounts
            .operator_approval
            .as_ref()
            .ok_or(VaultError::OperatorNotApproved)?;
        require!(
            approval.can_fulfill_deposit
                && approval.owner == deposit_request.owner
                && approval.operator == ctx.accounts.operator.key()
                && approval.vault == vault.key(),
            VaultError::OperatorNotApproved
        );
        let expected_pda = anchor_lang::solana_program::pubkey::Pubkey::create_program_address(
            &[
                OPERATOR_APPROVAL_SEED,
                vault.key().as_ref(),
                deposit_request.owner.as_ref(),
                ctx.accounts.operator.key().as_ref(),
                &[approval.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| VaultError::OperatorNotApproved)?;
        require!(
            approval.key() == expected_pda,
            VaultError::OperatorNotApproved
        );
    }

    if vault.cancel_after > 0 {
        let deadline = deposit_request
            .requested_at
            .checked_add(vault.cancel_after)
            .ok_or(VaultError::MathOverflow)?;
        require!(clock.unix_timestamp < deadline, VaultError::RequestExpired);
    }

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

    // Move assets from pending → fulfilled bucket.
    // total_assets and total_shares are updated at claim time to avoid
    // inflating share supply before the mint CPI completes.
    let vault = &mut ctx.accounts.vault;
    vault.total_pending_deposits = vault
        .total_pending_deposits
        .checked_sub(deposit_request.assets_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_fulfilled_deposits = vault
        .total_fulfilled_deposits
        .checked_add(deposit_request.assets_locked)
        .ok_or(VaultError::MathOverflow)?;

    emit!(DepositFulfilled {
        vault: vault.key(),
        owner: deposit_request.owner,
        shares: net_shares,
        assets: deposit_request.assets_locked,
    });

    Ok(())
}
