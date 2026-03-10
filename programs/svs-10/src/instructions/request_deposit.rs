//! Request deposit instruction: lock assets in vault, create pending deposit request.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::{DEPOSIT_REQUEST_SEED, MIN_DEPOSIT_AMOUNT},
    error::VaultError,
    events::DepositRequested,
    state::{AsyncVault, DepositRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct RequestDeposit<'info> {
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
        init,
        payer = user,
        space = DepositRequest::LEN,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestDeposit>, assets: u64) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    #[cfg(feature = "modules")]
    {
        let vault = &ctx.accounts.vault;
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;

        let total_assets = vault
            .total_assets
            .checked_add(vault.total_pending_deposits)
            .ok_or(VaultError::MathOverflow)?;
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            total_assets,
            assets,
        )?;
    }

    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_asset_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.total_pending_deposits = vault
        .total_pending_deposits
        .checked_add(assets)
        .ok_or(VaultError::MathOverflow)?;

    let deposit_request = &mut ctx.accounts.deposit_request;
    deposit_request.owner = ctx.accounts.user.key();
    deposit_request.receiver = ctx.accounts.user.key();
    deposit_request.vault = vault.key();
    deposit_request.assets_locked = assets;
    deposit_request.shares_claimable = 0;
    deposit_request.status = RequestStatus::Pending;
    deposit_request.requested_at = Clock::get()?.unix_timestamp;
    deposit_request.fulfilled_at = 0;
    deposit_request.bump = ctx.bumps.deposit_request;

    emit!(DepositRequested {
        vault: vault.key(),
        owner: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        assets,
    });

    Ok(())
}
