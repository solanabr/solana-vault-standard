//! Accrue-yield instruction: checkpoint accrued stream yield into base assets.

use anchor_lang::prelude::*;

use crate::{
    constants::VAULT_SEED,
    events::YieldAccrued,
    math::checkpoint_stream,
    state::NativeSolStreamVault,
};

#[derive(Accounts)]
pub struct Checkpoint<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, NativeSolStreamVault>,
}

pub fn handler(ctx: Context<Checkpoint>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault = &mut ctx.accounts.vault;
    let (accrued, _) = checkpoint_stream(vault, now)?;

    emit!(YieldAccrued {
        vault: vault.key(),
        accrued,
        new_base_assets: vault.base_assets,
        timestamp: now,
    });

    Ok(())
}
