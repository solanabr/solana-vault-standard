use crate::error::NavOracleError;
use crate::state::NavAccount;
use anchor_lang::prelude::*;

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
    let old_publisher = nav.publisher;
    nav.publisher = ctx.accounts.new_publisher.key();

    emit!(PublisherRotated {
        pool: nav.pool,
        old_publisher,
        new_publisher: nav.publisher,
        authority: ctx.accounts.key_rotation_authority.key(),
    });

    Ok(())
}

#[event]
pub struct PublisherRotated {
    /// CreditVault PDA this NavAccount is bound to.
    pub pool: Pubkey,
    /// Publisher pubkey before this rotation.
    pub old_publisher: Pubkey,
    /// Publisher pubkey now authorized to sign updates.
    pub new_publisher: Pubkey,
    /// Signer that authorized the rotation (matches
    /// `NavAccount.key_rotation_authority`).
    pub authority: Pubkey,
}
