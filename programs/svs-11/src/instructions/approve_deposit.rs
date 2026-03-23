use anchor_lang::prelude::*;

use crate::attestation::validate_attestation;
use crate::constants::{FROZEN_ACCOUNT_SEED, INVESTMENT_REQUEST_SEED, VAULT_SEED};
use crate::error::VaultError;
use crate::events::InvestmentApproved;
use crate::math;
use crate::oracle::read_and_validate_oracle;
use crate::state::{CreditVault, FrozenAccount, InvestmentRequest, RequestStatus};

#[derive(Accounts)]
pub struct ApproveDeposit<'info> {
    pub manager: Signer<'info>,

    #[account(
        mut,
        has_one = manager,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investment_request.investor.as_ref()],
        bump = investment_request.bump,
        constraint = investment_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub investment_request: Account<'info, InvestmentRequest>,

    #[account(constraint = investor.key() == investment_request.investor)]
    pub investor: SystemAccount<'info>,

    /// CHECK: Oracle account validated via read_and_validate_oracle
    pub nav_oracle: UncheckedAccount<'info>,

    /// CHECK: Attestation validated in handler via validate_attestation
    pub attestation: UncheckedAccount<'info>,

    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_check: Option<Account<'info, FrozenAccount>>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<ApproveDeposit>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(
        ctx.accounts.frozen_check.is_none(),
        VaultError::AccountFrozen
    );

    validate_attestation(
        &ctx.accounts.attestation.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.investor.key(),
        &ctx.accounts.clock,
    )?;

    let price = read_and_validate_oracle(
        &ctx.accounts.nav_oracle.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.clock,
    )?;

    let amount_locked = ctx.accounts.investment_request.amount_locked;
    let shares = math::assets_to_shares(amount_locked, price)?;
    require!(shares > 0, VaultError::ZeroAmount);

    let request = &mut ctx.accounts.investment_request;
    request.status = RequestStatus::Approved;
    request.shares_claimable = shares;
    request.fulfilled_at = ctx.accounts.clock.unix_timestamp;

    // Move assets from pending → approved bucket.
    // total_assets and total_shares are updated at claim time after the mint CPI.
    let vault = &mut ctx.accounts.vault;
    vault.total_pending_deposits = vault
        .total_pending_deposits
        .checked_sub(amount_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_approved_deposits = vault
        .total_approved_deposits
        .checked_add(amount_locked)
        .ok_or(VaultError::MathOverflow)?;

    emit!(InvestmentApproved {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        amount: amount_locked,
        shares,
        nav: price,
    });

    Ok(())
}
