use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    error::VaultError,
    events::InvestmentRequested,
    state::{CreditVault, InvestmentRequest, RequestStatus},
};

use super::oracle_lookup::{check_not_frozen, validate_attestation};

#[derive(Accounts)]
pub struct RequestDeposit<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
        constraint = vault.investment_window_open @ VaultError::InvestmentWindowClosed,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        init,
        payer = investor,
        space = InvestmentRequest::LEN,
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump
    )]
    pub investment_request: Account<'info, InvestmentRequest>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = investor_asset_account.mint == vault.asset_mint,
        constraint = investor_asset_account.owner == investor.key(),
    )]
    pub investor_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = deposit_vault.key() == vault.deposit_vault,
    )]
    pub deposit_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: FrozenAccount PDA — validated in handler
    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump
    )]
    pub frozen_account: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestDeposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    require!(
        amount >= vault.minimum_investment,
        VaultError::BelowMinimumInvestment
    );

    // Validate attestation from remaining_accounts
    let clock = Clock::get()?;
    validate_attestation(
        ctx.remaining_accounts,
        &vault.attestation_program,
        &ctx.accounts.investor.key(),
        &vault.attester,
        &clock,
    )?;

    // Check not frozen
    check_not_frozen(&ctx.accounts.frozen_account.to_account_info())?;

    // Delta-based accounting for T22 transfer fees
    let before = ctx.accounts.deposit_vault.amount;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.investor_asset_account.to_account_info(),
                to: ctx.accounts.deposit_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.investor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    ctx.accounts.deposit_vault.reload()?;
    let actual = ctx
        .accounts
        .deposit_vault
        .amount
        .checked_sub(before)
        .ok_or(VaultError::MathOverflow)?;

    let request = &mut ctx.accounts.investment_request;
    request.investor = ctx.accounts.investor.key();
    request.vault = vault.key();
    request.amount_locked = actual;
    request.shares_to_receive = 0;
    request.status = RequestStatus::Pending;
    request.requested_at = clock.unix_timestamp;
    request.bump = ctx.bumps.investment_request;

    emit!(InvestmentRequested {
        vault: vault.key(),
        investor: request.investor,
        amount: actual,
    });

    Ok(())
}
