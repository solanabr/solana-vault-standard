use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::Mint;

use crate::math::{convert_to_assets, convert_to_shares, Rounding};
use crate::state::ConfidentialStreamVault;

/// View context: vault + shares_mint. No asset_vault needed (streaming uses base_assets).
/// No VaultViewWithOwner — encrypted balances are unreadable on-chain (same as SVS-3).
#[derive(Accounts)]
pub struct VaultView<'info> {
    pub vault: Account<'info, ConfidentialStreamVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,
}

/// Returns effective_total_assets (base + accrued streaming yield).
pub fn total_assets(ctx: Context<VaultView>) -> Result<()> {
    let clock = Clock::get()?;
    let assets = ctx.accounts.vault.effective_total_assets(clock.unix_timestamp)?;
    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Returns how many shares you'd get for `assets` amount of deposit.
pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let clock = Clock::get()?;
    let total_assets = ctx.accounts.vault.effective_total_assets(clock.unix_timestamp)?;
    let total_shares = ctx.accounts.vault.total_shares;

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Returns how many assets you'd need to pay for `shares` amount of mint.
pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let clock = Clock::get()?;
    let total_assets = ctx.accounts.vault.effective_total_assets(clock.unix_timestamp)?;
    let total_shares = ctx.accounts.vault.total_shares;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Returns how many shares would be burned for `assets` amount of withdraw.
pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let clock = Clock::get()?;
    let total_assets = ctx.accounts.vault.effective_total_assets(clock.unix_timestamp)?;
    let total_shares = ctx.accounts.vault.total_shares;

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Returns how many assets you'd receive for `shares` amount of redeem.
pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let clock = Clock::get()?;
    let total_assets = ctx.accounts.vault.effective_total_assets(clock.unix_timestamp)?;
    let total_shares = ctx.accounts.vault.total_shares;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Convert assets to shares (generic helper).
pub fn view_convert_to_shares(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let clock = Clock::get()?;
    let total_assets = ctx.accounts.vault.effective_total_assets(clock.unix_timestamp)?;
    let total_shares = ctx.accounts.vault.total_shares;

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Convert shares to assets (generic helper).
pub fn view_convert_to_assets(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let clock = Clock::get()?;
    let total_assets = ctx.accounts.vault.effective_total_assets(clock.unix_timestamp)?;
    let total_shares = ctx.accounts.vault.total_shares;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Max deposit — returns vault's total assets as upper bound.
/// Individual per-user max cannot be computed (encrypted balances).
pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
    let clock = Clock::get()?;
    let total = ctx.accounts.vault.effective_total_assets(clock.unix_timestamp)?;
    set_return_data(&total.to_le_bytes());
    Ok(())
}

/// Max mint — returns u64::MAX (no on-chain limit, individual balance unknown).
pub fn max_mint(_ctx: Context<VaultView>) -> Result<()> {
    set_return_data(&u64::MAX.to_le_bytes());
    Ok(())
}

/// Max withdraw — returns vault's total assets (upper bound; can't read encrypted balance).
pub fn max_withdraw(ctx: Context<VaultView>) -> Result<()> {
    let clock = Clock::get()?;
    let total = ctx.accounts.vault.effective_total_assets(clock.unix_timestamp)?;
    set_return_data(&total.to_le_bytes());
    Ok(())
}

/// Max redeem — returns u64::MAX (can't read encrypted individual balance).
pub fn max_redeem(_ctx: Context<VaultView>) -> Result<()> {
    set_return_data(&u64::MAX.to_le_bytes());
    Ok(())
}
