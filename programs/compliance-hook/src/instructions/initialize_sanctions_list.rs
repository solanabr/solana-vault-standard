use anchor_lang::prelude::*;

use crate::error::ComplianceHookError;
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

    /// Singleton init is gated to the program's upgrade authority. Without
    /// this, the first caller post-deploy could claim `authority` and lock
    /// the legitimate operator out of all subsequent `update_sanctions_list`
    /// calls — with no recovery path other than redeploying under a new
    /// program ID (and updating every cross-program reference in svs-11).
    #[account(
        mut,
        constraint = program_data.upgrade_authority_address == Some(payer.key())
            @ ComplianceHookError::UnauthorizedAuthority,
    )]
    pub payer: Signer<'info>,

    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )]
    pub program_data: Account<'info, ProgramData>,

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
