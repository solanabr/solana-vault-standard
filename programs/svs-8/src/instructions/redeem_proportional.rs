use anchor_lang::prelude::*;
use crate::{
    error::VaultError,
    events::RedeemProportional as RedeemProportionalEvent,
    state::MultiAssetVault,
};

pub fn handler(
    ctx: Context<RedeemProportional>,
    _shares: u64,
    _min_assets_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    // Full implementation in Phase 3 — scaffold for compilation
    msg!("redeem_proportional: scaffold");
    Ok(())
}

#[derive(Accounts)]
pub struct RedeemProportional<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, MultiAssetVault>,

    pub system_program: Program<'info, System>,
}
