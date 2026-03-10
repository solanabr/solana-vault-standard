//! Cancel deposit instruction: return locked assets to user, close deposit request.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::{DEPOSIT_REQUEST_SEED, VAULT_SEED},
    error::VaultError,
    events::DepositCancelled,
    state::{AsyncVault, DepositRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct CancelDeposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        close = user,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump = deposit_request.bump,
        constraint = deposit_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
        constraint = deposit_request.owner == user.key() @ VaultError::InvalidRequestOwner,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelDeposit>) -> Result<()> {
    let assets_to_return = ctx.accounts.deposit_request.assets_locked;

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault_bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.user_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets_to_return,
        ctx.accounts.asset_mint.decimals,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.total_pending_deposits = vault
        .total_pending_deposits
        .checked_sub(assets_to_return)
        .ok_or(VaultError::MathOverflow)?;

    emit!(DepositCancelled {
        vault: vault.key(),
        owner: ctx.accounts.user.key(),
        assets_returned: assets_to_return,
    });

    Ok(())
}
