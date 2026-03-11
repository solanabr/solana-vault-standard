//! request_deposit: User locks assets, creates DepositRequest PDA.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::{ASYNC_VAULT_SEED, DEPOSIT_REQUEST_SEED},
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
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint @ VaultError::Unauthorized,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint @ VaultError::Unauthorized,
        constraint = user_asset_account.owner == user.key() @ VaultError::Unauthorized,
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault @ VaultError::Unauthorized,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    /// DepositRequest PDA — one per user per vault (init enforces uniqueness)
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

pub fn handler(ctx: Context<RequestDeposit>, assets: u64, receiver: Pubkey) -> Result<()> {
    // 1. VALIDATION
    require!(assets > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();
    let user_key = ctx.accounts.user.key();

    // 2. MODULE HOOKS (if enabled)
    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        // Access control check
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        // Cap enforcement (uses total_assets + new assets to include pending)
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            vault.total_assets,
            assets,
        )?;
    }

    // 3. TRANSFER ASSETS from user to asset_vault
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

    // 4. CREATE DEPOSIT REQUEST PDA
    let clock = Clock::get()?;
    let deposit_request = &mut ctx.accounts.deposit_request;
    deposit_request.vault = vault_key;
    deposit_request.owner = user_key;
    deposit_request.receiver = receiver;
    deposit_request.assets_locked = assets;
    deposit_request.shares_claimable = 0;
    deposit_request.status = RequestStatus::Pending;
    deposit_request.requested_at = clock.unix_timestamp;
    deposit_request.fulfilled_at = 0;
    deposit_request.bump = ctx.bumps.deposit_request;

    // 5. EMIT EVENT
    emit!(DepositRequested {
        vault: vault_key,
        owner: user_key,
        receiver,
        assets,
    });

    Ok(())
}
