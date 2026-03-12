use anchor_lang::prelude::*;

use crate::{
    error::TranchedVaultError,
    events::{AuthorityTransferred, ManagerChanged, VaultPaused, VaultUnpaused},
    state::TranchedVault,
};

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ TranchedVaultError::Unauthorized,
    )]
    pub vault: Account<'info, TranchedVault>,
}

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, TranchedVaultError::VaultPaused);
    ctx.accounts.vault.paused = true;
    emit!(VaultPaused {
        vault: ctx.accounts.vault.key()
    });
    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    require!(
        ctx.accounts.vault.paused,
        TranchedVaultError::VaultNotPaused
    );
    ctx.accounts.vault.paused = false;
    emit!(VaultUnpaused {
        vault: ctx.accounts.vault.key()
    });
    Ok(())
}

pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    let old_authority = ctx.accounts.vault.authority;
    ctx.accounts.vault.authority = new_authority;
    emit!(AuthorityTransferred {
        vault: ctx.accounts.vault.key(),
        old_authority,
        new_authority,
    });
    Ok(())
}

pub fn set_manager(ctx: Context<Admin>, new_manager: Pubkey) -> Result<()> {
    let old_manager = ctx.accounts.vault.manager;
    ctx.accounts.vault.manager = new_manager;
    emit!(ManagerChanged {
        vault: ctx.accounts.vault.key(),
        old_manager,
        new_manager,
    });
    Ok(())
}
