use anchor_lang::prelude::*;
use crate::error::NavOracleError;
use crate::state::NavAccount;

#[derive(Accounts)]
pub struct RotatePublisher<'info> {
    /// CHECK: pool seed validation.
    pub pool: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [NavAccount::SEED_PREFIX, pool.key().as_ref()],
        bump,
        has_one = key_rotation_authority @ NavOracleError::UnauthorizedRotation,
    )]
    pub nav_account: Account<'info, NavAccount>,

    /// Must sign. Production deployments typically wire this to a
    /// governance or multisig authority that proxies via a vault
    /// transaction.
    pub key_rotation_authority: Signer<'info>,

    /// CHECK: new publisher pubkey to install.
    pub new_publisher: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<RotatePublisher>) -> Result<()> {
    let nav = &mut ctx.accounts.nav_account;
    let old = nav.publisher;
    nav.publisher = ctx.accounts.new_publisher.key();

    msg!("Publisher rotated | pool={} old={} new={}", nav.pool, old, nav.publisher);
    Ok(())
}
