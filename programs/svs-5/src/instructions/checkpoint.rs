//! checkpoint instruction: permissionless crank to finalize accrued yield.
//!
//! Anyone (MEV bots, keepers, users) can call this to advance base_assets
//! by the amount of yield that has accrued since the last checkpoint.
//! This keeps base_assets synchronized with the effective total and reduces
//! drift between stream state and on-chain token balance.

use anchor_lang::prelude::*;

use crate::{
    constants::STREAM_VAULT_SEED,
    error::VaultError,
    events::CheckpointEvent,
    math::effective_total_assets,
    state::StreamVault,
};

#[derive(Accounts)]
pub struct Checkpoint<'info> {
    #[account(
        mut,
        seeds = [STREAM_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, StreamVault>,
    // Permissionless — no authority signer required
}

/// Finalize accrued yield into base_assets.
///
/// Computes how much yield has streamed since the last checkpoint and
/// permanently moves that amount from stream_amount into base_assets.
///
/// - Partial checkpoint (mid-stream): reduces stream_amount, advances stream_start.
/// - Complete checkpoint (stream ended): clears all stream state.
/// - No-op (nothing accrued): returns early without emitting an event.
pub fn handler(ctx: Context<Checkpoint>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Compute how much has accrued since last checkpoint
    let effective = effective_total_assets(vault, now)?;
    let accrued = effective
        .checked_sub(vault.base_assets)
        .ok_or(VaultError::MathOverflow)?;

    // Early exit if nothing to accrue (stream not started or already checkpointed)
    if accrued == 0 {
        return Ok(());
    }

    // Update base_assets to include newly accrued yield
    vault.base_assets = effective;

    if now >= vault.stream_end {
        // Stream complete — clear all stream state
        vault.stream_amount = 0;
        vault.stream_start = now;
        vault.stream_end = now;
    } else {
        // Partial checkpoint — reduce remaining stream amount and advance start
        vault.stream_amount = vault
            .stream_amount
            .checked_sub(accrued)
            .ok_or(VaultError::MathOverflow)?;
        vault.stream_start = now;
    }

    vault.last_checkpoint = now;

    emit!(CheckpointEvent {
        vault: vault.key(),
        accrued,
        new_base_assets: vault.base_assets,
        timestamp: now,
    });

    Ok(())
}
