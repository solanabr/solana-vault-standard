//! View instructions: read-only queries for vault state and conversions.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{
    math::{convert_to_assets, convert_to_shares, effective_total_assets, Rounding},
    state::Vault,
};

#[derive(Accounts)]
pub struct VaultView<'info> {
    pub vault: Account<'info, Vault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct VaultViewWithOwner<'info> {
    pub vault: Account<'info, Vault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        constraint = owner_shares_account.mint == vault.shares_mint,
    )]
    pub owner_shares_account: InterfaceAccount<'info, TokenAccount>,
}

pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let now = Clock::get()?.unix_timestamp;
    let total_assets = effective_total_assets(vault, now)?;
    let total_shares = ctx.accounts.shares_mint.supply;

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
    let now = Clock::get()?.unix_timestamp;
    let total_assets = effective_total_assets(vault, now)?;
    let total_shares = ctx.accounts.shares_mint.supply;

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
    let now = Clock::get()?.unix_timestamp;
    let total_assets = effective_total_assets(vault, now)?;
    let total_shares = ctx.accounts.shares_mint.supply;

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
    let now = Clock::get()?.unix_timestamp;
    let total_assets = effective_total_assets(vault, now)?;
    let total_shares = ctx.accounts.shares_mint.supply;

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
    preview_deposit(ctx, assets)
}

pub fn convert_to_assets_view(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let now = Clock::get()?.unix_timestamp;
    let total_assets = effective_total_assets(vault, now)?;
    let total_shares = ctx.accounts.shares_mint.supply;

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
    let now = Clock::get()?.unix_timestamp;
    let total_assets = effective_total_assets(&ctx.accounts.vault, now)?;
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
    let now = Clock::get()?.unix_timestamp;
    let total_assets = effective_total_assets(vault, now)?;
    let total_shares = ctx.accounts.shares_mint.supply;
    let owner_shares = ctx.accounts.owner_shares_account.amount;

    let max_assets = convert_to_assets(
        owner_shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&max_assets.min(total_assets).to_le_bytes());
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
