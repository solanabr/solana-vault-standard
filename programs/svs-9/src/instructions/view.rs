//! View instructions: read-only queries for vault state and conversions.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{
    math::{convert_to_assets, convert_to_shares, Rounding},
    state::*,
    utils::compute_total_assets,
};

#[derive(Accounts)]
pub struct VaultView<'info> {
    pub allocator_vault: Account<'info, AllocatorVault>,

    #[account(constraint = shares_mint.key() == allocator_vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(constraint = idle_vault.key() == allocator_vault.idle_vault)]
    pub idle_vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct VaultViewWithOwner<'info> {
    pub allocator_vault: Account<'info, AllocatorVault>,

    #[account(constraint = shares_mint.key() == allocator_vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(constraint = idle_vault.key() == allocator_vault.idle_vault)]
    pub idle_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = owner_shares_account.mint == allocator_vault.shares_mint,
    )]
    pub owner_shares_account: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct ChildAllocationView<'info> {
    pub child_allocation: Account<'info, ChildAllocation>,
}

/// Preview how many shares would be minted for given assets (floor rounding)
pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        vault.num_children,
        &ctx.remaining_accounts,
        vault.key(),
    )?;

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
    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        vault.num_children,
        &ctx.remaining_accounts,
        vault.key(),
    )?;

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
    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        vault.num_children,
        &ctx.remaining_accounts,
        vault.key(),
    )?;

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
    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        vault.num_children,
        &ctx.remaining_accounts,
        vault.key(),
    )?;

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
pub fn total_assets(ctx: Context<VaultView>) -> Result<()> {
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        ctx.accounts.allocator_vault.num_children,
        &ctx.remaining_accounts,
        ctx.accounts.allocator_vault.key(),
    )?;
    set_return_data(&total_assets.to_le_bytes());
    Ok(())
}

/// Convert assets to shares using floor rounding
pub fn convert_to_shares_view(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        vault.num_children,
        &ctx.remaining_accounts,
        vault.key(),
    )?;

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
    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        vault.num_children,
        &ctx.remaining_accounts,
        vault.key(),
    )?;

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

/// Maximum assets that can be deposited
pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
    let max = if ctx.accounts.allocator_vault.paused {
        0u64
    } else {
        u64::MAX
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum shares that can be minted
pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
    let max = if ctx.accounts.allocator_vault.paused {
        0u64
    } else {
        u64::MAX
    };
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum assets that owner can withdraw (bounded by idle vault)
pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    if ctx.accounts.allocator_vault.paused {
        set_return_data(&0u64.to_le_bytes());
        return Ok(());
    }

    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let owner_shares = ctx.accounts.owner_shares_account.amount;
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        vault.num_children,
        &ctx.remaining_accounts,
        vault.key(),
    )?;

    let max_from_shares = convert_to_assets(
        owner_shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // SVS-9 Liquidity Rule: Can only withdraw from idle_vault
    let max = max_from_shares.min(ctx.accounts.idle_vault.amount);
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// Maximum shares that owner can redeem (bounded by idle vault liquidity)
pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    if ctx.accounts.allocator_vault.paused {
        set_return_data(&0u64.to_le_bytes());
        return Ok(());
    }

    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        vault.num_children,
        &ctx.remaining_accounts,
        vault.key(),
    )?;

    let shares_for_idle = convert_to_shares(
        ctx.accounts.idle_vault.amount,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    let max = ctx
        .accounts
        .owner_shares_account
        .amount
        .min(shares_for_idle);
    set_return_data(&max.to_le_bytes());
    Ok(())
}

/// SVS-9 specific: Get idle balance
pub fn get_idle_balance(ctx: Context<VaultView>) -> Result<()> {
    set_return_data(&ctx.accounts.idle_vault.amount.to_le_bytes());
    Ok(())
}

/// SVS-9 specific: Get child allocation info
pub fn get_child_allocation_info(ctx: Context<ChildAllocationView>) -> Result<()> {
    let data = ctx.accounts.child_allocation.try_to_vec()?;
    set_return_data(&data);
    Ok(())
}
