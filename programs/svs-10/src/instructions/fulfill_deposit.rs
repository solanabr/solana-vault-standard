//! fulfill_deposit: Operator sets shares_claimable on a pending DepositRequest.

use anchor_lang::prelude::*;

use crate::{
    constants::{ASYNC_VAULT_SEED, DEPOSIT_REQUEST_SEED},
    error::VaultError,
    events::DepositFulfilled,
    math::{convert_to_shares, Rounding},
    state::{AsyncVault, DepositRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct FulfillDeposit<'info> {
    /// Must be vault.operator
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
        constraint = vault.operator == operator.key() @ VaultError::InvalidOperator,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
        has_one = vault @ VaultError::Unauthorized,
    )]
    pub deposit_request: Account<'info, DepositRequest>,
}

pub fn handler(ctx: Context<FulfillDeposit>) -> Result<()> {
    // 1. VALIDATION: request must be Pending
    require!(
        ctx.accounts.deposit_request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let vault = &ctx.accounts.vault;
    let assets_locked = ctx.accounts.deposit_request.assets_locked;

    // 2. COMPUTE SHARES using vault-priced mode
    // Uses stored total_assets/total_shares at fulfillment time.
    // Floor rounding — vault-favoring for deposits.
    let shares_claimable = convert_to_shares(
        assets_locked,
        vault.total_assets,
        vault.total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // 3. MODULE HOOK: apply entry fee at fulfillment
    #[cfg(feature = "modules")]
    let shares_claimable = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares_claimable)?;
        result.net_shares
    };

    let clock = Clock::get()?;
    let vault_key = ctx.accounts.vault.key();
    let owner = ctx.accounts.deposit_request.owner;

    // 4. UPDATE VAULT STATE
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_add(assets_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_add(shares_claimable)
        .ok_or(VaultError::MathOverflow)?;

    // 5. UPDATE REQUEST STATE
    let deposit_request = &mut ctx.accounts.deposit_request;
    deposit_request.shares_claimable = shares_claimable;
    deposit_request.status = RequestStatus::Fulfilled;
    deposit_request.fulfilled_at = clock.unix_timestamp;

    // 6. EMIT EVENT
    emit!(DepositFulfilled {
        vault: vault_key,
        owner,
        assets: assets_locked,
        shares: shares_claimable,
    });

    Ok(())
}
