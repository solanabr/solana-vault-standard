//! Mint instruction: mint exact shares by depositing required assets (streaming balance model).

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::VAULT_SEED,
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_assets, Rounding},
    state::StreamVault,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct MintShares<'info> {
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

/// Mint exact shares, paying required assets (ceiling rounding - protects vault)
///
/// IMPORTANT: Both deposit() and mint() enforce caps to prevent bypass.
pub fn handler(ctx: Context<MintShares>, shares: u64, max_assets_in: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // SVS-5: Auto-checkpoint for consistent pricing across all operations
    let vault = &mut ctx.accounts.vault;
    vault.checkpoint(now)?;

    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = vault.base_assets;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        // 1. Access control check (whitelist/blacklist + frozen)
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        // 2. Cap enforcement (critical: prevents cap bypass via mint)
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            total_assets,
            assets,
        )?;

        // 3. Apply entry fee - user requested `shares`, but gets fewer due to fee
        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = shares;

    require!(net_shares > 0, VaultError::ZeroAmount);
    require!(assets <= max_assets_in, VaultError::SlippageExceeded);

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

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_shares,
    )?;

    // SVS-5: Deposited assets are real, update base_assets directly
    let vault = &mut ctx.accounts.vault;
    vault.base_assets = vault
        .base_assets
        .checked_add(assets)
        .ok_or(VaultError::MathOverflow)?;

    emit!(DepositEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares: net_shares,
    });

    Ok(())
}
