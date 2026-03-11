use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::attestation::validate_sas_attestation;
use crate::constants::{FROZEN_ACCOUNT_SEED, INVESTMENT_REQUEST_SEED, VAULT_SEED};
use crate::error::VaultError;
use crate::events::InvestmentRequested;
use crate::state::{CreditVault, FrozenAccount, InvestmentRequest, RequestStatus};

#[derive(Accounts)]
pub struct RequestDeposit<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        init,
        payer = investor,
        space = InvestmentRequest::LEN,
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub investment_request: Account<'info, InvestmentRequest>,

    #[account(
        mut,
        constraint = investor_token_account.mint == vault.asset_mint,
        constraint = investor_token_account.owner == investor.key(),
    )]
    pub investor_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = deposit_vault.key() == vault.deposit_vault,
    )]
    pub deposit_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Validated in handler via validate_sas_attestation
    pub attestation: UncheckedAccount<'info>,

    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_check: Option<Account<'info, FrozenAccount>>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<RequestDeposit>, amount: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;

    require!(!vault.paused, VaultError::VaultPaused);
    require!(
        vault.investment_window_open,
        VaultError::InvestmentWindowClosed
    );
    require!(amount > 0, VaultError::ZeroAmount);
    require!(
        amount >= vault.minimum_investment,
        VaultError::DepositTooSmall
    );

    validate_sas_attestation(
        &ctx.accounts.attestation.to_account_info(),
        vault,
        &ctx.accounts.investor.key(),
        &ctx.accounts.clock,
    )?;

    require!(
        ctx.accounts.frozen_check.is_none(),
        VaultError::AccountFrozen
    );

    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.investor_token_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.deposit_vault.to_account_info(),
                authority: ctx.accounts.investor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    let request = &mut ctx.accounts.investment_request;
    request.investor = ctx.accounts.investor.key();
    request.vault = ctx.accounts.vault.key();
    request.amount_locked = amount;
    request.shares_claimable = 0;
    request.status = RequestStatus::Pending;
    request.requested_at = ctx.accounts.clock.unix_timestamp;
    request.fulfilled_at = 0;
    request.bump = ctx.bumps.investment_request;

    let vault = &mut ctx.accounts.vault;
    vault.total_pending_deposits = vault
        .total_pending_deposits
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;

    emit!(InvestmentRequested {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        amount,
    });

    Ok(())
}
