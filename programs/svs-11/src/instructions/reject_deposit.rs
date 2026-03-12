use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{INVESTMENT_REQUEST_SEED, VAULT_SEED};
use crate::error::VaultError;
use crate::events::InvestmentRejected;
use crate::state::{CreditVault, InvestmentRequest, RequestStatus};

#[derive(Accounts)]
pub struct RejectDeposit<'info> {
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
        close = investor,
        has_one = vault,
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investment_request.investor.as_ref()],
        bump = investment_request.bump,
        constraint = investment_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub investment_request: Account<'info, InvestmentRequest>,

    #[account(mut, constraint = investor.key() == investment_request.investor)]
    pub investor: SystemAccount<'info>,

    #[account(
        mut,
        constraint = deposit_vault.key() == vault.deposit_vault,
    )]
    pub deposit_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = investor_token_account.mint == vault.asset_mint,
        constraint = investor_token_account.owner == investor.key(),
    )]
    pub investor_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<RejectDeposit>, reason_code: u8) -> Result<()> {
    let amount_locked = ctx.accounts.investment_request.amount_locked;

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.deposit_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.investor_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        amount_locked,
        ctx.accounts.asset_mint.decimals,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.total_pending_deposits = vault
        .total_pending_deposits
        .checked_sub(amount_locked)
        .ok_or(VaultError::MathOverflow)?;

    emit!(InvestmentRejected {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        amount: amount_locked,
        reason_code,
    });

    Ok(())
}
