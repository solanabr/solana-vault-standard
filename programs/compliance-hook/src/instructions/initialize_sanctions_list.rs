use anchor_lang::prelude::*;

use crate::state::SanctionsList;

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

    /// Authority for future updates.
    /// CHECK: validated by storing pubkey only; future calls verify signer matches.
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

    emit!(SanctionsListInitialized {
        authority: list.authority,
        updated_at: list.updated_at,
    });

    Ok(())
}

#[event]
pub struct SanctionsListInitialized {
    /// Authority that gates all future `update_sanctions_list` and
    /// freeze/unfreeze calls.
    pub authority: Pubkey,
    /// Unix timestamp written into the list at init.
    pub updated_at: i64,
}
