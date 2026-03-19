//! Admin instructions: pause, unpause, transfer authority.

use anchor_lang::prelude::*;

use crate::{
    constants::VAULT_SEED,
    error::VaultError,
    events::{AuthorityTransferred, VaultStatusChanged},
    state::NativeSolStreamVault,
};

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, NativeSolStreamVault>,
}

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(!vault.paused, VaultError::VaultPaused);
    vault.paused = true;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: true,
    });
    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.paused, VaultError::VaultNotPaused);
    vault.paused = false;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: false,
    });
    Ok(())
}

pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let previous_authority = vault.authority;
    vault.authority = new_authority;

    emit!(AuthorityTransferred {
        vault: vault.key(),
        previous_authority,
        new_authority,
    });
    Ok(())
}
