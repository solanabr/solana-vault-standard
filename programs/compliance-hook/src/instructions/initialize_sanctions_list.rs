use anchor_lang::prelude::*;

use crate::state::SanctionsList;

/// Singleton init. The PDA itself prevents re-initialization (Anchor `init`
/// fails on second call). The operator MUST run this immediately after deploy
/// in the same script — the documented trust model is that whoever controls
/// the deploy controls the initial sanctions authority. A squat between deploy
/// and init is theoretical (requires mempool monitoring + winning race vs the
/// deploy script's init tx); recovery is to redeploy under a new program ID
/// and update svs-11's hardcoded reference. PR #25 precedent: trust-model
/// risks of this shape are accepted with documentation rather than gated by
/// upgrade-authority checks (which add cross-loader plumbing).
#[derive(Accounts)]
pub struct InitializeSanctionsList<'info> {
    #[account(
        init,
        payer = payer,
        space = SanctionsList::SPACE,
        seeds = [SanctionsList::SEED_PREFIX],
        bump,
    )]
    pub sanctions_list: Account<'info, SanctionsList>,

    /// CHECK: stored verbatim; future updates verify signer matches.
    pub authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeSanctionsList>) -> Result<()> {
    let list = &mut ctx.accounts.sanctions_list;
    list.authority = ctx.accounts.authority.key();
    list.version = 0;
    list.updated_at = Clock::get()?.unix_timestamp;
    list.addresses = Vec::new();

    msg!(
        "SanctionsList initialized | authority={} version=0",
        list.authority
    );
    Ok(())
}
