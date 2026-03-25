use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use svs_math::{convert_to_assets, convert_to_shares, Rounding};

use crate::constants::BPS_DENOMINATOR;
use crate::error::TranchedVaultError;
use crate::state::{Tranche, TranchedVault};

#[derive(Accounts)]
pub struct TrancheView<'info> {
    pub vault: Account<'info, TranchedVault>,

    #[account(has_one = vault @ TranchedVaultError::TrancheVaultMismatch)]
    pub tranche: Account<'info, Tranche>,
}

pub fn preview_deposit(ctx: Context<TrancheView>, assets: u64) -> Result<()> {
    let tranche = &ctx.accounts.tranche;
    let shares = convert_to_shares(
        assets,
        tranche.total_assets_allocated,
        tranche.total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )
    .map_err(|_| TranchedVaultError::MathOverflow)?;
    set_return_data(&shares.to_le_bytes());
    Ok(())
}

pub fn preview_redeem(ctx: Context<TrancheView>, shares: u64) -> Result<()> {
    let tranche = &ctx.accounts.tranche;
    let assets = convert_to_assets(
        shares,
        tranche.total_assets_allocated,
        tranche.total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )
    .map_err(|_| TranchedVaultError::MathOverflow)?;
    set_return_data(&assets.to_le_bytes());
    Ok(())
}

pub fn get_tranche_state(ctx: Context<TrancheView>) -> Result<()> {
    let tranche = &ctx.accounts.tranche;
    let vault = &ctx.accounts.vault;
    let cap_limit = (vault.total_assets as u128)
        .checked_mul(tranche.cap_bps as u128)
        .ok_or(TranchedVaultError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(TranchedVaultError::MathOverflow)? as u64;
    let headroom = cap_limit.saturating_sub(tranche.total_assets_allocated);

    let mut buf = [0u8; 24];
    buf[0..8].copy_from_slice(&tranche.total_assets_allocated.to_le_bytes());
    buf[8..16].copy_from_slice(&tranche.total_shares.to_le_bytes());
    buf[16..24].copy_from_slice(&headroom.to_le_bytes());
    set_return_data(&buf);
    Ok(())
}
