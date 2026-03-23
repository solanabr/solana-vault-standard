//! View instructions: read-only queries for vault state and conversions.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::Mint;

use crate::{
    math::{convert_to_assets, convert_to_shares, Rounding},
    state::ConfidentialStreamVault,
};

#[derive(Accounts)]
pub struct VaultView<'info> {
    pub vault: Account<'info, ConfidentialStreamVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,
}

pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let clock = Clock::get()?;
    let total_assets = vault.effective_total_assets(clock.unix_timestamp)?;

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
    let clock = Clock::get()?;
    let total_assets = vault.effective_total_assets(clock.unix_timestamp)?;

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
    let clock = Clock::get()?;
    let total_assets = vault.effective_total_assets(clock.unix_timestamp)?;

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
    let clock = Clock::get()?;
    let total_assets = vault.effective_total_assets(clock.unix_timestamp)?;

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
    let clock = Clock::get()?;
    let total_assets = vault.effective_total_assets(clock.unix_timestamp)?;

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
    let clock = Clock::get()?;
    let total_assets = vault.effective_total_assets(clock.unix_timestamp)?;

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
    let clock = Clock::get()?;
    let total_assets = ctx
        .accounts
        .vault
        .effective_total_assets(clock.unix_timestamp)?;
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

/// Cannot compute on-chain with encrypted balances — return 0, SDK handles preview.
pub fn max_withdraw(_ctx: Context<VaultView>) -> Result<()> {
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

/// Cannot compute on-chain with encrypted balances — return 0, SDK handles preview.
pub fn max_redeem(_ctx: Context<VaultView>) -> Result<()> {
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

pub fn get_stream_info(ctx: Context<VaultView>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let clock = Clock::get()?;
    let effective_total = vault.effective_total_assets(clock.unix_timestamp)?;

    let mut data = [0u8; 48];
    data[0..8].copy_from_slice(&vault.base_assets.to_le_bytes());
    data[8..16].copy_from_slice(&vault.stream_amount.to_le_bytes());
    data[16..24].copy_from_slice(&vault.stream_start.to_le_bytes());
    data[24..32].copy_from_slice(&vault.stream_end.to_le_bytes());
    data[32..40].copy_from_slice(&effective_total.to_le_bytes());
    data[40..48].copy_from_slice(&vault.last_checkpoint.to_le_bytes());
    set_return_data(&data);
    Ok(())
}
