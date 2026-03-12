use anchor_lang::prelude::*;

use crate::{
    error::VaultError,
    events::{AttesterChanged, AuthorityTransferred, ManagerChanged, VaultStatusChanged},
    state::CreditVault,
};

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, CreditVault>,
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
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAuthority
    );
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

pub fn set_manager(ctx: Context<Admin>, new_manager: Pubkey) -> Result<()> {
    require!(new_manager != Pubkey::default(), VaultError::InvalidManager);
    let vault = &mut ctx.accounts.vault;
    let previous_manager = vault.manager;
    vault.manager = new_manager;

    emit!(ManagerChanged {
        vault: vault.key(),
        previous_manager,
        new_manager,
    });

    Ok(())
}

pub fn update_attester(ctx: Context<Admin>, new_attester: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let previous_attester = vault.attester;
    vault.attester = new_attester;

    emit!(AttesterChanged {
        vault: vault.key(),
        previous_attester,
        new_attester,
    });

    Ok(())
}
