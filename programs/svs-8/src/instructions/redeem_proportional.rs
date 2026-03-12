use anchor_lang::prelude::*;
use crate::{
    error::VaultError,
    events::RedeemProportional as RedeemProportionalEvent,
    state::MultiAssetVault,
};

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, RedeemProportional<'info>>,
    _shares: u64,
    _min_assets_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);

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
