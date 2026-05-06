use anchor_lang::prelude::*;

use crate::error::ComplianceHookError;
use crate::state::{FrozenAccount, SanctionsList};

/// Unfreeze a previously-frozen wallet.
///
/// Closes the canonical `[b"frozen", owner_to_unfreeze]` PDA, returning
/// the rent lamports to `rent_recipient`. After close the freeze PDA's
/// lamports drop to 0 and Anchor zeroes its data, so the `execute`
/// handler's existence check (`lamports() > 0 && data_len() > 0`) reads
/// false and the wallet may transfer again.
///
/// Authority: same as `freeze_account` — must equal
/// `SanctionsList.authority`.
#[derive(Accounts)]
pub struct UnfreezeAccount<'info> {
    /// SanctionsList singleton; gates this ix via `has_one = authority`.
    #[account(
        seeds = [SanctionsList::SEED_PREFIX],
        bump,
        has_one = authority @ ComplianceHookError::UnauthorizedAuthority,
    )]
    pub sanctions_list: Account<'info, SanctionsList>,

    pub authority: Signer<'info>,

    /// CHECK: the wallet whose freeze PDA we close. Stored verbatim
    /// into the freeze PDA seed.
    pub owner_to_unfreeze: UncheckedAccount<'info>,

    /// Per-wallet freeze marker PDA. `close = rent_recipient` returns
    /// rent lamports and zeros the data, satisfying the freeze CHECK in
    /// `execute` to read false thereafter.
    #[account(
        mut,
        close = rent_recipient,
        seeds = [FrozenAccount::SEED_PREFIX, owner_to_unfreeze.key().as_ref()],
        bump = frozen_account.bump,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,

    /// CHECK: receives the closed account's lamports. Typically the
    /// authority's wallet or a designated rent-collection account.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<UnfreezeAccount>) -> Result<()> {
    msg!(
        "FrozenAccount closed | owner={} authority={} rent_recipient={}",
        ctx.accounts.owner_to_unfreeze.key(),
        ctx.accounts.authority.key(),
        ctx.accounts.rent_recipient.key(),
    );
    Ok(())
}
