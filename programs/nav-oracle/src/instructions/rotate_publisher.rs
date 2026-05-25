use crate::error::NavOracleError;
use crate::state::NavAccount;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RotatePublisher<'info> {
    /// CHECK: seed-only.
    pub pool: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [NavAccount::SEED_PREFIX, pool.key().as_ref()],
        bump,
        has_one = key_rotation_authority @ NavOracleError::UnauthorizedRotation,
    )]
    pub nav_account: Account<'info, NavAccount>,

    pub key_rotation_authority: Signer<'info>,

    /// CHECK: pubkey stored verbatim.
    pub new_publisher: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<RotatePublisher>) -> Result<()> {
    let nav = &mut ctx.accounts.nav_account;
    let new_publisher = ctx.accounts.new_publisher.key();
    require!(
        new_publisher != Pubkey::default(),
        NavOracleError::InvalidNewPublisher
    );

    nav.publisher = new_publisher;
    Ok(())
}
