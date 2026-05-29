use crate::error::NavOracleError;
use crate::state::NavAccount;
use crate::SVS_11_PROGRAM_ID;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RotatePublisher<'info> {
    /// CHECK: SVS-11 CreditVault PDA; owner + authority validated in handler.
    pub pool: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [NavAccount::SEED_PREFIX, pool.key().as_ref()],
        bump,
        constraint = nav_account.pool == pool.key() @ NavOracleError::PoolAccountInvalid,
    )]
    pub nav_account: Account<'info, NavAccount>,

    /// Must equal the live CreditVault.authority (pool bytes 8..40).
    pub authority: Signer<'info>,

    /// CHECK: pubkey stored verbatim.
    pub new_publisher: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<RotatePublisher>) -> Result<()> {
    require!(
        ctx.accounts.pool.owner == &SVS_11_PROGRAM_ID,
        NavOracleError::PoolAccountInvalid
    );

    let pool_data = ctx.accounts.pool.try_borrow_data()?;
    require!(pool_data.len() >= 40, NavOracleError::PoolAccountInvalid);

    // CreditVault.authority lives at pool bytes 8..40 (Anchor disc + first
    // field); guarded producing-side by SVS-11's
    // credit_vault_authority_offset_stable_for_nav_oracle_gate test.
    let authority_bytes: [u8; 32] = pool_data[8..40]
        .try_into()
        .map_err(|_| error!(NavOracleError::PoolAccountInvalid))?;
    require!(
        authority_bytes == ctx.accounts.authority.key().to_bytes(),
        NavOracleError::UnauthorizedRotation
    );
    drop(pool_data);

    let new_publisher = ctx.accounts.new_publisher.key();
    require!(
        new_publisher != Pubkey::default(),
        NavOracleError::InvalidNewPublisher
    );

    ctx.accounts.nav_account.publisher = new_publisher;
    Ok(())
}
