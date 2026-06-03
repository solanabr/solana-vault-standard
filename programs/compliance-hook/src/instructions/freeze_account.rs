use anchor_lang::prelude::*;

use crate::error::ComplianceHookError;
use crate::state::{FrozenAccount, SanctionsList};

/// Mark a wallet as frozen across all hook-bound mints by creating
/// `[b"frozen", owner]`. `execute` reads PDA existence to reject transfers.
#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    #[account(
        seeds = [SanctionsList::SEED_PREFIX],
        bump,
        has_one = authority @ ComplianceHookError::UnauthorizedAuthority,
    )]
    pub sanctions_list: Account<'info, SanctionsList>,

    pub authority: Signer<'info>,

    /// CHECK: stored verbatim in PDA seed; not deserialized.
    pub owner_to_freeze: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = FrozenAccount::SPACE,
        seeds = [FrozenAccount::SEED_PREFIX, owner_to_freeze.key().as_ref()],
        bump,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<FreezeAccount>) -> Result<()> {
    ctx.accounts.frozen_account.bump = ctx.bumps.frozen_account;
    Ok(())
}
