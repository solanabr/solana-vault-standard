//! View instructions: read-only queries for vault state and conversions.
//!
//! All view functions dispatch on vault.balance_model to determine total_assets:
//! - Live: reads wsol_vault.amount directly
//! - Stored: reads vault.total_assets field

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{
    math::{convert_to_assets, convert_to_shares, Rounding},
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct VaultView<'info> {
    pub vault: Account<'info, SolVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(constraint = wsol_vault.key() == vault.wsol_vault)]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct VaultViewWithOwner<'info> {
    pub vault: Account<'info, SolVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(constraint = wsol_vault.key() == vault.wsol_vault)]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(constraint = owner_shares_account.mint == vault.shares_mint)]
    pub owner_shares_account: InterfaceAccount<'info, TokenAccount>,
}

/// Resolve total_assets based on the vault's balance model.
fn resolve_total_assets(vault: &SolVault, wsol_vault_amount: u64) -> u64 {
    match vault.balance_model {
        BalanceModel::Live => wsol_vault_amount,
        BalanceModel::Stored => vault.total_assets,
    }
}

/// Preview how many shares would be minted for given lamports (floor rounding)
pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = resolve_total_assets(vault, ctx.accounts.wsol_vault.amount);

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Preview how many lamports are required to mint exact shares (ceiling rounding)
pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = resolve_total_assets(vault, ctx.accounts.wsol_vault.amount);

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Preview how many shares must be burned to withdraw exact lamports (ceiling rounding)
pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = resolve_total_assets(vault, ctx.accounts.wsol_vault.amount);

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Preview how many lamports would be received for redeeming shares (floor rounding)
pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = resolve_total_assets(vault, ctx.accounts.wsol_vault.amount);

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Convert lamports to shares using floor rounding
pub fn convert_to_shares_view(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = resolve_total_assets(vault, ctx.accounts.wsol_vault.amount);

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Convert shares to lamports using floor rounding
pub fn convert_to_assets_view(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = resolve_total_assets(vault, ctx.accounts.wsol_vault.amount);

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Get total lamports managed by the vault (model-aware)
pub fn get_total_assets(ctx: Context<VaultView>) -> Result<()> {
    let total_assets = resolve_total_assets(&ctx.accounts.vault, ctx.accounts.wsol_vault.amount);
    set_return_data(&total_assets.to_le_bytes());
    Ok(())
}

/// Maximum lamports depositable (u64::MAX if not paused, 0 if paused)
pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
    let max = if ctx.accounts.vault.paused { 0u64 } else { u64::MAX };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum shares mintable (u64::MAX if not paused, 0 if paused)
pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
    let max = if ctx.accounts.vault.paused { 0u64 } else { u64::MAX };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum lamports an owner can withdraw (limited by their shares)
pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    if ctx.accounts.vault.paused {
        set_return_data(&0u64.to_le_bytes());
        return Ok(());
    }

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let owner_shares = ctx.accounts.owner_shares_account.amount;
    let total_assets = resolve_total_assets(vault, ctx.accounts.wsol_vault.amount);

    let max_assets = convert_to_assets(
        owner_shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // Cap at vault's total assets
    let max = max_assets.min(total_assets);
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum shares an owner can redeem (their share balance)
pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        ctx.accounts.owner_shares_account.amount
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}
