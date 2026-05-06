use anchor_lang::prelude::*;

use crate::error::ComplianceHookError;
use crate::state::SanctionsList;

#[derive(Accounts)]
pub struct UpdateSanctionsList<'info> {
    #[account(
        mut,
        seeds = [SanctionsList::SEED_PREFIX],
        bump,
        has_one = authority @ ComplianceHookError::UnauthorizedAuthority,
    )]
    pub sanctions_list: Account<'info, SanctionsList>,

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateSanctionsList>,
    additions: Vec<Pubkey>,
    removals: Vec<Pubkey>,
) -> Result<()> {
    let list = &mut ctx.accounts.sanctions_list;

    // Apply removals first (deduplicates idempotent re-adds)
    list.addresses.retain(|a| !removals.contains(a));

    // Append additions (skip if already present)
    for add in additions.iter() {
        if !list.addresses.contains(add) {
            require!(
                list.addresses.len() < SanctionsList::MAX_ADDRESSES,
                ComplianceHookError::SanctionsListFull
            );
            list.addresses.push(*add);
        }
    }

    list.version = list
        .version
        .checked_add(1)
        .ok_or(ComplianceHookError::SanctionsListVersionOverflow)?;
    list.updated_at = Clock::get()?.unix_timestamp;

    emit!(SanctionsListUpdated {
        version: list.version,
        added: additions,
        removed: removals,
        authority: ctx.accounts.authority.key(),
        updated_at: list.updated_at,
    });

    Ok(())
}

#[event]
pub struct SanctionsListUpdated {
    pub version: u64,
    pub added: Vec<Pubkey>,
    pub removed: Vec<Pubkey>,
    pub authority: Pubkey,
    pub updated_at: i64,
}
