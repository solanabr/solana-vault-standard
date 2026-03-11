//! View instructions: read-only queries for vault state and conversions.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{
    math::{convert_to_assets, convert_to_shares, Rounding},
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct SolVaultView<'info> {
    pub vault: Account<'info, SolVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(constraint = wsol_vault.key() == vault.wsol_vault)]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct SolVaultViewWithOwner<'info> {
    pub vault: Account<'info, SolVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(constraint = wsol_vault.key() == vault.wsol_vault)]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = owner_shares_account.mint == vault.shares_mint,
    )]
    pub owner_shares_account: InterfaceAccount<'info, TokenAccount>,
}

/// Read total assets based on vault's balance model.
fn read_total_assets(vault: &SolVault, wsol_vault: &InterfaceAccount<TokenAccount>) -> u64 {
    match vault.balance_model {
        BalanceModel::Live => wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    }
}

/// Preview how many shares would be minted for given assets (floor rounding)
pub fn preview_deposit(ctx: Context<SolVaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = read_total_assets(vault, &ctx.accounts.wsol_vault);

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

/// Preview how many assets are required to mint exact shares (ceiling rounding)
pub fn preview_mint(ctx: Context<SolVaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = read_total_assets(vault, &ctx.accounts.wsol_vault);

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

/// Preview how many shares must be burned to withdraw exact assets (ceiling rounding)
pub fn preview_withdraw(ctx: Context<SolVaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = read_total_assets(vault, &ctx.accounts.wsol_vault);

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

/// Preview how many assets would be received for redeeming shares (floor rounding)
pub fn preview_redeem(ctx: Context<SolVaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = read_total_assets(vault, &ctx.accounts.wsol_vault);

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

/// Convert assets to shares using floor rounding
pub fn convert_to_shares_view(ctx: Context<SolVaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = read_total_assets(vault, &ctx.accounts.wsol_vault);

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

/// Convert shares to assets using floor rounding
pub fn convert_to_assets_view(ctx: Context<SolVaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = read_total_assets(vault, &ctx.accounts.wsol_vault);

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

/// Get total assets managed by the vault
pub fn get_total_assets(ctx: Context<SolVaultView>) -> Result<()> {
    let total_assets = read_total_assets(&ctx.accounts.vault, &ctx.accounts.wsol_vault);
    set_return_data(&total_assets.to_le_bytes());
    Ok(())
}

/// Maximum assets that can be deposited (u64::MAX if not paused, 0 if paused)
pub fn max_deposit(ctx: Context<SolVaultView>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        u64::MAX
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum shares that can be minted (u64::MAX if not paused, 0 if paused)
pub fn max_mint(ctx: Context<SolVaultView>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        u64::MAX
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum assets owner can withdraw (limited by their shares)
pub fn max_withdraw(ctx: Context<SolVaultViewWithOwner>) -> Result<()> {
    if ctx.accounts.vault.paused {
        set_return_data(&0u64.to_le_bytes());
        return Ok(());
    }

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let owner_shares = ctx.accounts.owner_shares_account.amount;
    let total_assets = read_total_assets(vault, &ctx.accounts.wsol_vault);

    let max_assets = convert_to_assets(
        owner_shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    let max = max_assets.min(total_assets);
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum shares that owner can redeem (their share balance)
pub fn max_redeem(ctx: Context<SolVaultViewWithOwner>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        ctx.accounts.owner_shares_account.amount
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}
