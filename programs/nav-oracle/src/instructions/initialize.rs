use crate::error::NavOracleError;
use crate::state::NavAccount;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeNavArgs {
    /// Max allowed consecutive-publish deviation, in bps. MUST be > 0 (a zero
    /// ceiling would reject every consecutive publish).
    pub max_deviation_bps: u16,
}

#[derive(Accounts)]
pub struct InitializeNavAccount<'info> {
    /// CHECK: SVS-11 CreditVault PDA. Read in handler to verify `pool_authority`.
    pub pool: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = NavAccount::SPACE,
        seeds = [NavAccount::SEED_PREFIX, pool.key().as_ref()],
        bump,
    )]
    pub nav_account: Account<'info, NavAccount>,

    /// Must match `CreditVault.authority` (bytes 8..40 of `pool` account data).
    /// Gates per-pool init so attackers cannot squat the NavAccount PDA for
    /// someone else's pool.
    pub pool_authority: Signer<'info>,

    /// CHECK: pubkey stored verbatim.
    pub publisher: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeNavAccount>, args: InitializeNavArgs) -> Result<()> {
    require!(
        args.max_deviation_bps > 0,
        NavOracleError::InvalidDeviationConfig
    );

    // Gate: when pool has data (real CreditVault), require pool_authority
    // signer matches CreditVault.authority at bytes 8..40 (Anchor discriminator
    // + first field). Empty pool accounts are accepted — the attack we close
    // is squatting NavAccount for a *real* pool PDA, and a real CreditVault
    // always has data. An attacker cannot create a fake account at a
    // legitimate pool's PDA address (System would need the PDA's private key).
    let pool_data = ctx.accounts.pool.try_borrow_data()?;
    if pool_data.len() >= 40 {
        let stored_authority_bytes: [u8; 32] = pool_data[8..40]
            .try_into()
            .map_err(|_| error!(NavOracleError::PoolAccountInvalid))?;
        require!(
            stored_authority_bytes == ctx.accounts.pool_authority.key().to_bytes(),
            NavOracleError::UnauthorizedPoolInit
        );
    }
    drop(pool_data);

    let nav = &mut ctx.accounts.nav_account;
    nav.version = NavAccount::HEADER_VERSION;
    nav.nav_net = 0;
    nav.timestamp = 0;
    nav.sequence = 0;
    nav.pool = ctx.accounts.pool.key();
    nav.nav_gross = 0;
    nav.ter_bps = 0;
    nav.loss_provision_bps = 0;
    nav.nav_type = 0;
    nav._padding = [0u8; 7];
    nav.publisher = ctx.accounts.publisher.key();
    nav.signature = [0u8; 64];
    nav.loan_tape_merkle_root = [0u8; 32];
    nav.last_published_nav = 0;
    nav.max_deviation_bps = args.max_deviation_bps;

    Ok(())
}
