use crate::state::NavAccount;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeNavAccount<'info> {
    /// CHECK: seed-only; not dereferenced.
    pub pool: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = NavAccount::SPACE,
        seeds = [NavAccount::SEED_PREFIX, pool.key().as_ref()],
        bump,
    )]
    pub nav_account: Account<'info, NavAccount>,

    /// CHECK: pubkey stored verbatim.
    pub publisher: UncheckedAccount<'info>,

    /// CHECK: pubkey stored verbatim; gates publisher rotation.
    pub key_rotation_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeNavAccount>) -> Result<()> {
    let nav = &mut ctx.accounts.nav_account;
    nav.pool = ctx.accounts.pool.key();
    nav.nav_net = 0;
    nav.nav_gross = 0;
    nav.ter_bps = 0;
    nav.loss_provision_bps = 0;
    nav.nav_type = 0;
    nav._padding = [0u8; 7];
    nav.timestamp = 0;
    nav.sequence = 0;
    nav.publisher = ctx.accounts.publisher.key();
    nav.signature = [0u8; 64];
    nav.loan_tape_merkle_root = [0u8; 32];
    nav.key_rotation_authority = ctx.accounts.key_rotation_authority.key();

    Ok(())
}
