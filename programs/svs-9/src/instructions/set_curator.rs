//! Set curator instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::ALLOCATOR_VAULT_SEED,
    error::VaultError,
    events::CuratorChanged,
    state::AllocatorVault,
};

#[derive(Accounts)]
pub struct SetCurator<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    pub vault_id: u64,
    pub new_curator: Pubkey,
}

pub fn handler(
    ctx: Context<SetCurator>,
    new_curator: Pubkey,
) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let old_curator = allocator.curator;
    
    allocator.curator = new_curator;

    emit_cpi!(CuratorChanged {
        allocator: allocator.key(),
        old_curator,
        new_curator,
    });

    Ok(())
}
