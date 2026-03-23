//! Request redeem instruction.
//!
//! Intentionally does NOT require investment_window_open — investors should
//! always be able to signal intent to redeem, regardless of window state.
//! The manager gates actual execution via approve_redeem.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::attestation::validate_attestation;
use crate::constants::{
    FROZEN_ACCOUNT_SEED, REDEMPTION_ESCROW_SEED, REDEMPTION_REQUEST_SEED, SHARES_DECIMALS,
    VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionRequested;
use crate::state::{CreditVault, FrozenAccount, RedemptionRequest, RequestStatus};

#[derive(Accounts)]
pub struct RequestRedeem<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        init,
        payer = investor,
        space = RedemptionRequest::LEN,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = investor_shares_account.mint == vault.shares_mint,
        constraint = investor_shares_account.owner == investor.key(),
    )]
    pub investor_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump = vault.redemption_escrow_bump,
    )]
    pub redemption_escrow: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Attestation validated in handler via validate_attestation
    pub attestation: UncheckedAccount<'info>,

    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_check: Option<Account<'info, FrozenAccount>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<RequestRedeem>, shares: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    validate_attestation(
        &ctx.accounts.attestation.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.investor.key(),
        &ctx.accounts.clock,
    )?;

    require!(
        ctx.accounts.frozen_check.is_none(),
        VaultError::AccountFrozen
    );

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.investor_shares_account.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.redemption_escrow.to_account_info(),
                authority: ctx.accounts.investor.to_account_info(),
            },
        ),
        shares,
        SHARES_DECIMALS,
    )?;

    let request = &mut ctx.accounts.redemption_request;
    request.investor = ctx.accounts.investor.key();
    request.vault = ctx.accounts.vault.key();
    request.shares_locked = shares;
    request.assets_claimable = 0;
    request.status = RequestStatus::Pending;
    request.requested_at = ctx.accounts.clock.unix_timestamp;
    request.fulfilled_at = 0;
    request.bump = ctx.bumps.redemption_request;

    emit!(RedemptionRequested {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.investor.key(),
        shares,
    });

    Ok(())
}
