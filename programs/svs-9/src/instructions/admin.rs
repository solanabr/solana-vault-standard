use crate::error::*;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,
}

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
    require!(!vault.paused, VaultError::VaultPaused);
    vault.paused = true;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: true,
    });

    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
    require!(vault.paused, VaultError::VaultNotPaused);
    vault.paused = false;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: false,
    });

    Ok(())
}

pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(new_authority != Pubkey::default(), VaultError::Unauthorized);
    let vault = &mut ctx.accounts.allocator_vault;
    let previous_authority = vault.authority;
    vault.authority = new_authority;

    emit!(AuthorityTransferred {
        vault: vault.key(),
        previous_authority,
        new_authority,
    });

    Ok(())
}

pub fn set_curator(ctx: Context<Admin>, new_curator: Pubkey) -> Result<()> {
    require!(new_curator != Pubkey::default(), VaultError::Unauthorized);
    let vault = &mut ctx.accounts.allocator_vault;
    let old_curator = vault.curator;
    vault.curator = new_curator;

    emit!(CuratorTransferred {
        vault: vault.key(),
        old_curator,
        new_curator,
    });

    Ok(())
}
