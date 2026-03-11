use anchor_lang::prelude::*;

use crate::{
    constants::DEPOSIT_REQUEST_SEED,
    error::VaultError,
    events::DepositFulfilled,
    instructions::oracle_lookup::find_oracle_price,
    math::{convert_to_shares, Rounding},
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
        constraint = vault.operator != Pubkey::default() @ VaultError::OperatorNotSet,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
    )]
    pub deposit_request: Account<'info, DepositRequest>,
}

pub fn handler(ctx: Context<FulfillDeposit>) -> Result<()> {
    let request = &ctx.accounts.deposit_request;

    require!(
        request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();

    // Compute gross shares: Mode A (oracle) or Mode B (vault-priced)
    let gross_shares = if let Some((price, updated_at)) =
        find_oracle_price(ctx.remaining_accounts, &crate::ID, &vault_key)?
    {
        let clock = Clock::get()?;
        svs_oracle::validate_oracle(price, updated_at, clock.unix_timestamp, vault.max_staleness)
            .map_err(|e| match e {
            svs_oracle::OracleError::StalePrice => VaultError::StaleOraclePrice,
            svs_oracle::OracleError::InvalidPrice => VaultError::InvalidOraclePrice,
            svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
            svs_oracle::OracleError::UnauthorizedUpdate => VaultError::Unauthorized,
            svs_oracle::OracleError::PriceDeviationExceeded => VaultError::InvalidOraclePrice,
        })?;
        svs_oracle::assets_to_shares(request.assets_locked, price)
            .map_err(|_| VaultError::MathOverflow)?
    } else {
        convert_to_shares(
            request.assets_locked,
            vault.total_assets,
            vault.total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?
    };

    // Apply module hooks if enabled
    #[cfg(feature = "modules")]
    let shares = {
        let remaining = ctx.remaining_accounts;
        let owner_key = request.owner;

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &owner_key, &[])?;
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &owner_key,
            vault.total_assets,
            request.assets_locked,
        )?;

        let result =
            module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, gross_shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let shares = gross_shares;

    // Bug #1: Increment totals HERE only (claim_deposit must NOT touch these)
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_add(request.assets_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;

    let clock = Clock::get()?;
    let request = &mut ctx.accounts.deposit_request;
    request.shares_claimable = shares;
    request.status = RequestStatus::Fulfilled;
    request.fulfilled_at = clock.unix_timestamp;

    emit!(DepositFulfilled {
        vault: vault.key(),
        owner: request.owner,
        assets: request.assets_locked,
        shares,
    });

    Ok(())
}
