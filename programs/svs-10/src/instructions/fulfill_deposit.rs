use anchor_lang::prelude::*;

use crate::{
    constants::DEPOSIT_REQUEST_SEED,
    error::VaultError,
    events::DepositFulfilled,
    math::{convert_to_shares, Rounding},
    state::{AsyncVault, DepositRequest, RequestStatus},
};

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

    // Mode B: Vault-priced (use stored total_assets/total_shares)
    // Bug #2: Never read asset_vault.amount for pricing — use vault.total_assets
    let shares = convert_to_shares(
        request.assets_locked,
        vault.total_assets,
        vault.total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

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
