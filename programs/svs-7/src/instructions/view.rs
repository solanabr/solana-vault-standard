//! View instructions: read-only queries for vault state and conversions.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::{
    token::TokenAccount,
    token_interface::{Mint, TokenAccount as InterfaceTokenAccount},
};

use crate::{
    math::{convert_to_assets, convert_to_shares, Rounding},
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct VaultView<'info> {
    pub vault: Account<'info, SolVault>,

    #[account(
        constraint = wsol_vault.key() == vault.wsol_vault,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

    #[account(
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct VaultViewWithOwner<'info> {
    pub vault: Account<'info, SolVault>,

    #[account(
        constraint = wsol_vault.key() == vault.wsol_vault,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

    #[account(
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        constraint = owner_shares_account.mint == vault.shares_mint,
    )]
    pub owner_shares_account: InterfaceAccount<'info, InterfaceTokenAccount>,
}

fn total_assets_value(vault: &SolVault, wsol_vault: &TokenAccount) -> u64 {
    match vault.balance_model {
        BalanceModel::Live => wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    }
}

pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = total_assets_value(vault, &ctx.accounts.wsol_vault);

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

pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = total_assets_value(vault, &ctx.accounts.wsol_vault);

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

pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = total_assets_value(vault, &ctx.accounts.wsol_vault);

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

pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = total_assets_value(vault, &ctx.accounts.wsol_vault);

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

pub fn convert_to_shares_view(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = total_assets_value(vault, &ctx.accounts.wsol_vault);

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

pub fn convert_to_assets_view(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = total_assets_value(vault, &ctx.accounts.wsol_vault);

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

pub fn get_total_assets(ctx: Context<VaultView>) -> Result<()> {
    let total_assets = total_assets_value(&ctx.accounts.vault, &ctx.accounts.wsol_vault);
    set_return_data(&total_assets.to_le_bytes());
    Ok(())
}

pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        u64::MAX
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        u64::MAX
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    if ctx.accounts.vault.paused {
        set_return_data(&0u64.to_le_bytes());
        return Ok(());
    }

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let owner_shares = ctx.accounts.owner_shares_account.amount;
    let total_assets = total_assets_value(vault, &ctx.accounts.wsol_vault);

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

pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        ctx.accounts.owner_shares_account.amount
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}
