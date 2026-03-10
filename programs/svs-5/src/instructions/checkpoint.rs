//! Checkpoint instruction: finalize accrued streaming yield into base_assets.
//!
//! Permissionless — anyone can call to materialize already-accrued yield.

use anchor_lang::prelude::*;

use crate::{error::VaultError, events::Checkpointed, state::StreamVault};

#[derive(Accounts)]
pub struct Checkpoint<'info> {
    #[account(mut)]
    pub vault: Account<'info, StreamVault>,
}

pub fn handler(ctx: Context<Checkpoint>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let vault = &mut ctx.accounts.vault;

    let accrued = vault
        .effective_total_assets(now)?
        .checked_sub(vault.base_assets)
        .ok_or(VaultError::MathOverflow)?;

    if accrued == 0 {
        return Ok(());
    }

    vault.base_assets = vault
        .base_assets
        .checked_add(accrued)
        .ok_or(VaultError::MathOverflow)?;

    if now >= vault.stream_end {
        vault.stream_amount = 0;
        vault.stream_start = 0;
        vault.stream_end = 0;
    } else {
        vault.stream_amount = vault
            .stream_amount
            .checked_sub(accrued)
            .ok_or(VaultError::MathOverflow)?;
        vault.stream_start = now;
    }

    vault.last_checkpoint = now;

    emit!(Checkpointed {
        vault: vault.key(),
        accrued,
        new_base_assets: vault.base_assets,
        timestamp: now,
    });

    Ok(())
}
