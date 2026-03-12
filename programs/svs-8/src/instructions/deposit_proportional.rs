use anchor_lang::prelude::*;
use crate::{
    error::VaultError,
    events::DepositProportional as DepositProportionalEvent,
    state::MultiAssetVault,
};

pub fn handler(
    ctx: Context<DepositProportional>,
    _base_amount: u64,
    _min_shares_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    // Full implementation in Phase 3 — scaffold for compilation
    msg!("deposit_proportional: scaffold");
    Ok(())
}

#[derive(Accounts)]
pub struct DepositProportional<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, MultiAssetVault>,

    pub system_program: Program<'info, System>,
}
