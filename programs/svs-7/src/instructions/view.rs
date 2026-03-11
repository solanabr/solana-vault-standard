//! View functions: CPI-composable read-only previews.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use svs_math::{convert_to_assets, convert_to_shares, Rounding};

use crate::{
    constants::SOL_VAULT_SEED,
    error::VaultError,
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct VaultView<'info> {
    #[account(
        seeds = [SOL_VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, SolVault>,
    pub shares_mint: InterfaceAccount<'info, Mint>,
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,
}

fn total_assets_inner(vault: &SolVault, wsol_amount: u64) -> u64 {
    match vault.balance_model {
        BalanceModel::Live => wsol_amount,
        BalanceModel::Stored => vault.total_assets,
    }
}

pub fn preview_deposit(ctx: Context<VaultView>, lamports: u64) -> Result<()> {
    let ta = total_assets_inner(&ctx.accounts.vault, ctx.accounts.wsol_vault.amount);
    let shares = convert_to_shares(
        lamports, ta, ctx.accounts.shares_mint.supply,
        ctx.accounts.vault.decimals_offset, Rounding::Floor,
    ).map_err(|_| error!(VaultError::MathOverflow))?;
    anchor_lang::solana_program::program::set_return_data(&shares.to_le_bytes());
    Ok(())
}

pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let ta = total_assets_inner(&ctx.accounts.vault, ctx.accounts.wsol_vault.amount);
    let lamports = convert_to_assets(
        shares, ta, ctx.accounts.shares_mint.supply,
        ctx.accounts.vault.decimals_offset, Rounding::Floor,
    ).map_err(|_| error!(VaultError::MathOverflow))?;
    anchor_lang::solana_program::program::set_return_data(&lamports.to_le_bytes());
    Ok(())
}

pub fn preview_withdraw(ctx: Context<VaultView>, lamports: u64) -> Result<()> {
    let ta = total_assets_inner(&ctx.accounts.vault, ctx.accounts.wsol_vault.amount);
    let shares = convert_to_shares(
        lamports, ta, ctx.accounts.shares_mint.supply,
        ctx.accounts.vault.decimals_offset, Rounding::Ceiling,
    ).map_err(|_| error!(VaultError::MathOverflow))?;
    anchor_lang::solana_program::program::set_return_data(&shares.to_le_bytes());
    Ok(())
}

pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let ta = total_assets_inner(&ctx.accounts.vault, ctx.accounts.wsol_vault.amount);
    let lamports = convert_to_assets(
        shares, ta, ctx.accounts.shares_mint.supply,
        ctx.accounts.vault.decimals_offset, Rounding::Ceiling,
    ).map_err(|_| error!(VaultError::MathOverflow))?;
    anchor_lang::solana_program::program::set_return_data(&lamports.to_le_bytes());
    Ok(())
}

pub fn get_total_assets(ctx: Context<VaultView>) -> Result<()> {
    let ta = total_assets_inner(&ctx.accounts.vault, ctx.accounts.wsol_vault.amount);
    anchor_lang::solana_program::program::set_return_data(&ta.to_le_bytes());
    Ok(())
}

pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
    let val: u64 = if ctx.accounts.vault.paused { 0 } else { u64::MAX };
    anchor_lang::solana_program::program::set_return_data(&val.to_le_bytes());
    Ok(())
}

pub fn max_redeem(ctx: Context<VaultView>) -> Result<()> {
    let val: u64 = if ctx.accounts.vault.paused { 0 } else { u64::MAX };
    anchor_lang::solana_program::program::set_return_data(&val.to_le_bytes());
    Ok(())
}
