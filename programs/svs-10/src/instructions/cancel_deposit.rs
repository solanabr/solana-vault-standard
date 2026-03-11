//! cancel_deposit: Cancel pending deposit request, return assets to user.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::{ASYNC_VAULT_SEED, DEPOSIT_REQUEST_SEED},
    error::VaultError,
    events::DepositRequestCancelled,
    state::{AsyncVault, DepositRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct CancelDeposit<'info> {
    /// Request owner — must be signer and match deposit_request.owner
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = deposit_request.bump,
        has_one = vault @ VaultError::Unauthorized,
        has_one = owner @ VaultError::Unauthorized,
        close = owner,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint @ VaultError::Unauthorized,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault @ VaultError::Unauthorized,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint @ VaultError::Unauthorized,
        constraint = user_asset_account.owner == owner.key() @ VaultError::Unauthorized,
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelDeposit>) -> Result<()> {
    // 1. VALIDATION: request must be Pending
    require!(
        ctx.accounts.deposit_request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let assets_locked = ctx.accounts.deposit_request.assets_locked;
    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();
    let owner_key = ctx.accounts.owner.key();

    // 2. BUILD VAULT PDA SIGNER SEEDS
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // 3. RETURN ASSETS to user
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
        assets_locked,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 4. CLOSE DEPOSIT REQUEST PDA (done via `close = owner` constraint)

    // 5. EMIT EVENT
    emit!(DepositRequestCancelled {
        vault: vault_key,
        owner: owner_key,
        assets_returned: assets_locked,
    });

    Ok(())
}
