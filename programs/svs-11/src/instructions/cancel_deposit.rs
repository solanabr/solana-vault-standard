use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    error::VaultError,
    events::InvestmentCancelled,
    state::{CreditVault, InvestmentRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct CancelDeposit<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        constraint = investment_request.investor == investor.key() @ VaultError::Unauthorized,
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump = investment_request.bump,
        close = investor,
    )]
    pub investment_request: Account<'info, InvestmentRequest>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = deposit_vault.key() == vault.deposit_vault,
    )]
    pub deposit_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = investor_asset_account.mint == vault.asset_mint,
        constraint = investor_asset_account.owner == investor.key(),
    )]
    pub investor_asset_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<CancelDeposit>) -> Result<()> {
    let request = &ctx.accounts.investment_request;

    require!(
        request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    // SVS-11: No cancel delay — instant cancel while Pending
    let assets_to_return = request.amount_locked;

    let vault = &ctx.accounts.vault;
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        CREDIT_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.deposit_vault.to_account_info(),
                to: ctx.accounts.investor_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets_to_return,
        ctx.accounts.asset_mint.decimals,
    )?;

    emit!(InvestmentCancelled {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        amount: assets_to_return,
    });

    Ok(())
}
