//! Admin instructions: pause, unpause, transfer authority, set vault operator.

use anchor_lang::prelude::*;

use crate::{
    error::VaultError,
    events::{AuthorityTransferred, CancelAfterChanged, VaultOperatorChanged, VaultStatusChanged},
    state::AsyncVault,
};

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, AsyncVault>,
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
        VaultError::InvalidAddress
    );

    let vault = &mut ctx.accounts.vault;
    let previous_authority = vault.authority;

    vault.authority = new_authority;

    emit!(AuthorityTransferred {
        vault: vault.key(),
        old_authority: previous_authority,
        new_authority,
    });

    Ok(())
}

pub fn set_vault_operator(ctx: Context<Admin>, new_operator: Pubkey) -> Result<()> {
    require!(
        new_operator != Pubkey::default(),
        VaultError::InvalidAddress
    );

    let vault = &mut ctx.accounts.vault;
    let old_operator = vault.operator;

    vault.operator = new_operator;

    emit!(VaultOperatorChanged {
        vault: vault.key(),
        old_operator,
        new_operator,
    });

    Ok(())
}

pub fn set_cancel_after(ctx: Context<Admin>, cancel_after: i64) -> Result<()> {
    require!(cancel_after >= 0, VaultError::InvalidParameter);

    ctx.accounts.vault.cancel_after = cancel_after;

    emit!(CancelAfterChanged {
        vault: ctx.accounts.vault.key(),
        cancel_after,
    });
    Ok(())
}
