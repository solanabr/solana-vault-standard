use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    error::VaultError,
    events::InvestmentRejected,
    state::{CreditVault, InvestmentRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct RejectDeposit<'info> {
    pub manager: Signer<'info>,

    #[account(
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investment_request.investor.as_ref()],
        bump = investment_request.bump,
        close = investor,
    )]
    pub investment_request: Account<'info, InvestmentRequest>,

    /// CHECK: Validated via investment_request.investor
    #[account(
        mut,
        constraint = investor.key() == investment_request.investor @ VaultError::Unauthorized,
    )]
    pub investor: UncheckedAccount<'info>,

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
        constraint = investor_asset_account.owner == investment_request.investor @ VaultError::Unauthorized,
    )]
    pub investor_asset_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<RejectDeposit>, reason_code: u8) -> Result<()> {
    let request = &ctx.accounts.investment_request;

    require!(
        request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let assets_to_return = request.amount_locked;
    let investor_key = request.investor;

    require!(
        ctx.accounts.deposit_vault.amount >= assets_to_return,
        VaultError::InsufficientAssets
    );

    let vault = &ctx.accounts.vault;
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        CREDIT_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ]];

    // Return locked assets to investor
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

    // PDA closed via `close = investor` constraint
    emit!(InvestmentRejected {
        vault: vault.key(),
        investor: investor_key,
        amount: assets_to_return,
        reason_code,
    });

    Ok(())
}
