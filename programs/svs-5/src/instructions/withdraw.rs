//! Withdraw instruction: burn shares to receive exact assets.
//!
//! SVS-5 key difference from SVS-1: total_assets is computed via
//! effective_total_assets(now) instead of asset_vault.amount.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::STREAM_VAULT_SEED,
    error::VaultError,
    events::Withdraw as WithdrawEvent,
    math::{convert_to_shares, effective_total_assets, Rounding},
    state::StreamVault,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, StreamVault>,

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
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Withdraw exact assets, burning required shares (ceiling rounding - protects vault).
///
/// SVS-5: uses effective_total_assets(now) for share price computation.
///
/// With modules feature enabled, pass module config PDAs via remaining_accounts:
/// - LockConfig + ShareLock: checks if shares are still locked
/// - FeeConfig: applies exit fee (fee retained in vault for later collection)
/// - AccessConfig + FrozenAccount: access control checks
pub fn handler(ctx: Context<Withdraw>, assets: u64, max_shares_in: u64) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);

    // SVS-5: Use time-interpolated balance
    let clock = Clock::get()?;
    let total_assets = effective_total_assets(&ctx.accounts.vault, clock.unix_timestamp)?;

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let (net_assets, _fee_assets) = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        // 1. Access control check (frozen account)
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;

        // 2. Lock check - ensure shares are not locked
        module_hooks::check_share_lock(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            clock.unix_timestamp,
        )?;

        // 3. Apply exit fee
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, assets)?;
        (result.net_assets, result.fee_assets)
    };

    #[cfg(not(feature = "modules"))]
    let net_assets = assets;

    // Total assets to withdraw from vault (user requested this much)
    let total_assets_needed = assets;

    require!(
        total_assets_needed <= total_assets,
        VaultError::InsufficientAssets
    );

    // Calculate shares to burn based on requested assets (ceiling rounding - user burns more)
    let shares = convert_to_shares(
        total_assets_needed,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    // Slippage check
    require!(shares <= max_shares_in, VaultError::SlippageExceeded);

    // Check user has enough shares
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    // Burn shares from user
    token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // Checkpoint accrued yield into base_assets before subtracting withdrawal.
    // Without this, base_assets can underflow when withdrawing during an active stream
    // because effective_total_assets includes yield that hasn't been added to base_assets yet.
    {
        let vault = &mut ctx.accounts.vault;
        if vault.stream_amount > 0 {
            let effective = effective_total_assets(vault, clock.unix_timestamp)?;
            let accrued = effective
                .checked_sub(vault.base_assets)
                .ok_or(VaultError::MathOverflow)?;
            if accrued > 0 {
                vault.base_assets = effective;
                if clock.unix_timestamp >= vault.stream_end {
                    vault.stream_amount = 0;
                    vault.stream_start = clock.unix_timestamp;
                    vault.stream_end = clock.unix_timestamp;
                } else {
                    vault.stream_amount = vault
                        .stream_amount
                        .checked_sub(accrued)
                        .ok_or(VaultError::MathOverflow)?;
                    vault.stream_start = clock.unix_timestamp;
                }
                vault.last_checkpoint = clock.unix_timestamp;
            }
        }
        vault.base_assets = vault
            .base_assets
            .checked_sub(net_assets)
            .ok_or(VaultError::MathOverflow)?;
    }

    // Prepare vault signer seeds
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        STREAM_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // Transfer net assets to user (fee stays in vault for later collection)
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
        net_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    emit!(WithdrawEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets: net_assets,
        shares,
    });

    Ok(())
}
