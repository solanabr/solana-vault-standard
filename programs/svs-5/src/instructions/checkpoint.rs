//! Checkpoint instruction: finalize accrued streaming yield into base_assets.
//!
//! Permissionless — anyone can call to materialize already-accrued yield.

use anchor_lang::prelude::*;

use crate::{constants::VAULT_SEED, events::Checkpointed, state::StreamVault};

#[derive(Accounts)]
pub struct Checkpoint<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, StreamVault>,
}

pub fn handler(ctx: Context<Checkpoint>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let vault = &mut ctx.accounts.vault;

    let accrued = vault.checkpoint(now)?;

    if accrued == 0 {
        return Ok(());
    }

    emit!(Checkpointed {
        vault: vault.key(),
        accrued,
        new_base_assets: vault.base_assets,
        timestamp: now,
    });

    Ok(())
}
