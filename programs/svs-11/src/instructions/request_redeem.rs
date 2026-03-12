use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::VaultError,
    events::RedemptionRequested,
    state::{CreditVault, RedemptionRequest, RedemptionStatus},
};

use super::oracle_lookup::{check_not_frozen, validate_attestation};

#[derive(Accounts)]
pub struct RequestRedeem<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        init,
        payer = investor,
        space = RedemptionRequest::LEN,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = investor_shares_account.mint == vault.shares_mint,
        constraint = investor_shares_account.owner == investor.key(),
    )]
    pub investor_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = redemption_escrow.key() == vault.redemption_escrow,
    )]
    pub redemption_escrow: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: FrozenAccount PDA — validated in handler
    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump
    )]
    pub frozen_account: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestRedeem>, shares: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    require!(
        ctx.accounts.investor_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    // Validate attestation
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;
    validate_attestation(
        ctx.remaining_accounts,
        &vault.attestation_program,
        &ctx.accounts.investor.key(),
        &vault.attester,
        &clock,
    )?;

    // Check not frozen
    check_not_frozen(&ctx.accounts.frozen_account.to_account_info())?;

    // Transfer shares to escrow
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.investor_shares_account.to_account_info(),
                to: ctx.accounts.redemption_escrow.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                authority: ctx.accounts.investor.to_account_info(),
            },
        ),
        shares,
        SHARES_DECIMALS,
    )?;

    let request = &mut ctx.accounts.redemption_request;
    request.investor = ctx.accounts.investor.key();
    request.vault = vault.key();
    request.shares_locked = shares;
    request.amount_claimable = 0;
    request.status = RedemptionStatus::Pending;
    request.requested_at = clock.unix_timestamp;
    request.bump = ctx.bumps.redemption_request;

    emit!(RedemptionRequested {
        vault: vault.key(),
        investor: request.investor,
        shares,
    });

    Ok(())
}
