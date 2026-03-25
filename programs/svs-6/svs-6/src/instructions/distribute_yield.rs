use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::VaultError;
use crate::events::{CheckpointEvent, DistributeYieldEvent};
use crate::math::calculate_checkpoint;
use crate::state::ConfidentialStreamVault;

/// Authority-only instruction to start a new yield stream.
///
/// If an existing stream is still in progress, it auto-checkpoints first
/// (settling accrued yield into base_assets before starting the new stream).
///
/// The yield amount must already be present in asset_vault — this instruction
/// does NOT transfer tokens. The authority should transfer yield tokens to
/// asset_vault before calling distribute_yield.
#[derive(Accounts)]
pub struct DistributeYield<'info> {
    /// Vault authority — only they can distribute yield.
    pub authority: Signer<'info>,

    /// Vault state — must not be paused, authority must match.
    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialStreamVault>,
}

pub fn handler(
    ctx: Context<DistributeYield>,
    amount: u64,
    duration_seconds: i64,
) -> Result<()> {
    // 1. VALIDATION
    require!(amount > 0, VaultError::ZeroStreamAmount);
    require!(
        duration_seconds >= MIN_STREAM_DURATION && duration_seconds <= MAX_STREAM_DURATION,
        VaultError::InvalidStreamDuration,
    );

    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // 2. AUTO-CHECKPOINT if an existing stream is still active
    if vault.stream_amount > 0 && vault.stream_end > vault.stream_start {
        let old_base = vault.base_assets;

        let (new_base, new_stream) = calculate_checkpoint(
            vault.base_assets,
            vault.stream_amount,
            vault.stream_start,
            vault.stream_end,
            now,
        )?;

        vault.base_assets = new_base;
        vault.stream_amount = new_stream;
        vault.stream_start = now;
        vault.last_checkpoint = now;

        emit!(CheckpointEvent {
            vault: ctx.accounts.vault.key(),
            caller: ctx.accounts.authority.key(),
            old_base_assets: old_base,
            new_base_assets: new_base,
            remaining_stream: new_stream,
        });
    }

    // 3. START NEW STREAM
    // Add any remaining un-streamed amount to the new stream
    let total_stream = vault
        .stream_amount
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;

    vault.stream_amount = total_stream;
    vault.stream_start = now;
    vault.stream_end = now
        .checked_add(duration_seconds)
        .ok_or(VaultError::MathOverflow)?;

    // 4. EMIT EVENT
    emit!(DistributeYieldEvent {
        vault: ctx.accounts.vault.key(),
        authority: ctx.accounts.authority.key(),
        amount,
        stream_start: vault.stream_start,
        stream_end: vault.stream_end,
    });

    Ok(())
}
