use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::events::CheckpointEvent;
use crate::math::calculate_checkpoint;
use crate::state::ConfidentialStreamVault;

/// Permissionless instruction that settles accrued streaming yield into base_assets.
///
/// Anyone can call this — it's critical for keeping yield accounting accurate.
/// Must be called in the same transaction as withdraw/redeem to prevent
/// stale-price exploits from yield accruing between preview and execution.
///
/// After checkpoint:
///   base_assets += accrued
///   stream_amount -= accrued
///   stream_start = now
///   last_checkpoint = now
///   stream_end unchanged
#[derive(Accounts)]
pub struct Checkpoint<'info> {
    /// Anyone can call checkpoint — permissionless.
    pub caller: Signer<'info>,

    /// Vault state — mutable to update streaming fields.
    /// Note: checkpoint works even when paused (critical for accurate accounting).
    #[account(mut)]
    pub vault: Account<'info, ConfidentialStreamVault>,
}

pub fn handler(ctx: Context<Checkpoint>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // 1. VALIDATION — must have an active or completed stream
    require!(
        vault.stream_amount > 0 || vault.stream_end > vault.stream_start,
        VaultError::NoActiveStream,
    );

    // 2. COMPUTE — calculate how much yield has accrued
    let old_base = vault.base_assets;

    let (new_base, new_stream) = calculate_checkpoint(
        vault.base_assets,
        vault.stream_amount,
        vault.stream_start,
        vault.stream_end,
        now,
    )?;

    // 3. UPDATE STATE
    vault.base_assets = new_base;
    vault.stream_amount = new_stream;
    vault.stream_start = now;
    vault.last_checkpoint = now;
    // stream_end stays the same — the end date doesn't change

    // 4. EMIT EVENT
    emit!(CheckpointEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.caller.key(),
        old_base_assets: old_base,
        new_base_assets: new_base,
        remaining_stream: new_stream,
    });

    Ok(())
}
