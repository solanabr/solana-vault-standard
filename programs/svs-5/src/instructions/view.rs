//! View instructions: read-only queries for vault state and conversions.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{
    math::{convert_to_assets, convert_to_shares, Rounding},
    state::StreamVault,
};

/// SVS-5 view context: uses effective_total_assets (time-interpolated).
#[derive(Accounts)]
pub struct VaultView<'info> {
    pub vault: Account<'info, StreamVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct VaultViewWithOwner<'info> {
    pub vault: Account<'info, StreamVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        constraint = owner_shares_account.mint == vault.shares_mint,
    )]
    pub owner_shares_account: InterfaceAccount<'info, TokenAccount>,
}

/// Preview how many shares would be minted for given assets (floor rounding)
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

/// Preview how many assets are required to mint exact shares (ceiling rounding)
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

/// Preview how many shares must be burned to withdraw exact assets (ceiling rounding)
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

/// Preview how many assets would be received for redeeming shares (floor rounding)
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

/// Convert assets to shares using floor rounding
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

/// Convert shares to assets using floor rounding
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

/// Get effective total assets (base_assets + accrued stream yield)
pub fn get_total_assets(ctx: Context<VaultView>) -> Result<()> {
    let clock = Clock::get()?;
    let total_assets = ctx
        .accounts
        .vault
        .effective_total_assets(clock.unix_timestamp)?;
    set_return_data(&total_assets.to_le_bytes());
    Ok(())
}

/// Maximum assets that can be deposited (u64::MAX if not paused, 0 if paused)
pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        u64::MAX
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum shares that can be minted (u64::MAX if not paused, 0 if paused)
pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        u64::MAX
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum assets that owner can withdraw (limited by their shares)
pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    if ctx.accounts.vault.paused {
        set_return_data(&0u64.to_le_bytes());
        return Ok(());
    }

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let owner_shares = ctx.accounts.owner_shares_account.amount;
    let clock = Clock::get()?;
    let total_assets = vault.effective_total_assets(clock.unix_timestamp)?;

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
pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    let max = if ctx.accounts.vault.paused {
        0u64
    } else {
        ctx.accounts.owner_shares_account.amount
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Get streaming yield state info
pub fn get_stream_info(ctx: Context<VaultView>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let clock = Clock::get()?;
    let effective_total = vault.effective_total_assets(clock.unix_timestamp)?;

    // Pack stream info: base_assets(8) + stream_amount(8) + stream_start(8) + stream_end(8) + effective_total(8) + last_checkpoint(8)
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
