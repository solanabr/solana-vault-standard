use anchor_lang::prelude::*;

use crate::error::ComplianceHookError;
use crate::state::{FrozenAccount, SanctionsList};

/// Close `[b"frozen", owner]`. After close, `execute`'s existence check
/// (`lamports() > 0 && data_len() > 0`) reads false.
#[derive(Accounts)]
pub struct UnfreezeAccount<'info> {
    #[account(
        seeds = [SanctionsList::SEED_PREFIX],
        bump,
        has_one = authority @ ComplianceHookError::UnauthorizedAuthority,
    )]
    pub sanctions_list: Account<'info, SanctionsList>,

    pub authority: Signer<'info>,

    /// CHECK: stored verbatim in PDA seed.
    pub owner_to_unfreeze: UncheckedAccount<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [FrozenAccount::SEED_PREFIX, owner_to_unfreeze.key().as_ref()],
        bump = frozen_account.bump,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,

    /// CHECK: receives the closed account's lamports.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
}

pub fn handler(_ctx: Context<UnfreezeAccount>) -> Result<()> {
    Ok(())
}
