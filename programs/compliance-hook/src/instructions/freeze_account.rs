use anchor_lang::prelude::*;

use crate::error::ComplianceHookError;
use crate::state::{FrozenAccount, SanctionsList};

/// Mark a wallet as frozen across all hook-bound mints.
///
/// Creates the canonical `[b"frozen", owner_to_freeze]` PDA owned by
/// compliance-hook with non-empty data. The `execute` handler reads PDA
/// existence at this seed for both source and destination owners and
/// rejects with `AccountFrozen` if either is frozen.
///
/// Authority: must equal `SanctionsList.authority` (the singleton's
/// authority field, typically a governance or multisig authority). Same
/// authority that controls the sanctions-list updates, so the
/// freeze + sanctions surfaces share a single rotation point.
///
/// `owner_to_freeze` is an `UncheckedAccount` because we don't validate
/// ownership of the wallet — this is the generic "frozen by global
/// authority" model. The wallet may be a regular Solana keypair, a PDA
/// from another program, or even a non-existent address; only the seed
/// derivation matters for the freeze check downstream.
#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    /// SanctionsList singleton — its `authority` field gates this ix.
    /// Anchor's `has_one = authority` enforces the match against the
    /// `authority` signer below; failure yields `UnauthorizedAuthority`.
    #[account(
        seeds = [SanctionsList::SEED_PREFIX],
        bump,
        has_one = authority @ ComplianceHookError::UnauthorizedAuthority,
    )]
    pub sanctions_list: Account<'info, SanctionsList>,

    /// The freeze authority. Must match `SanctionsList.authority` (enforced
    /// by `has_one` above).
    pub authority: Signer<'info>,

    /// CHECK: the wallet to mark frozen. Stored verbatim into the freeze
    /// PDA seed; not deserialized.
    pub owner_to_freeze: UncheckedAccount<'info>,

    /// Per-wallet freeze marker PDA. `init` enforces single-creation —
    /// freezing an already-frozen wallet returns "account already in use",
    /// which is the correct semantics (idempotent freeze without
    /// double-spending rent).
    #[account(
        init,
        payer = payer,
        space = FrozenAccount::SPACE,
        seeds = [FrozenAccount::SEED_PREFIX, owner_to_freeze.key().as_ref()],
        bump,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,

    /// Pays rent for the freeze PDA. Separate from `authority` so a cheap
    /// operator key can fund without holding the freeze authority.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<FreezeAccount>) -> Result<()> {
    ctx.accounts.frozen_account.bump = ctx.bumps.frozen_account;

    emit!(AccountFrozen {
        owner: ctx.accounts.owner_to_freeze.key(),
        authority: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event]
pub struct AccountFrozen {
    /// Wallet now blocked from any hook-bound transfer.
    pub owner: Pubkey,
    /// Signer that authorized the freeze (matches `SanctionsList.authority`).
    pub authority: Pubkey,
}
