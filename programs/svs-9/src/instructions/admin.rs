//! Admin instructions for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::ALLOCATOR_VAULT_SEED,
    error::VaultError,
    events::{VaultStatusChanged, CuratorChanged},
    state::AllocatorVault,
};

#[derive(Accounts)]
pub struct Admin<'info> {
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
}

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    
    allocator.paused = true;

    emit_cpi!(VaultStatusChanged {
        vault: allocator.key(),
        paused: true,
        authority: ctx.accounts.authority.key(),
    });

    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    
    allocator.paused = false;

    emit_cpi!(VaultStatusChanged {
        vault: allocator.key(),
        paused: false,
        authority: ctx.accounts.authority.key(),
    });

    Ok(())
}

pub fn transfer_authority(
    ctx: Context<Admin>,
    new_authority: Pubkey,
) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let old_authority = allocator.authority;
    
    allocator.authority = new_authority;

    emit_cpi!(VaultStatusChanged {
        vault: allocator.key(),
        paused: allocator.paused,
        authority: old_authority,
    });

    Ok(())
}
