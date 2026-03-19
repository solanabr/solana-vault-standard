//! Admin instructions: pause, unpause, sync, transfer authority.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, TokenAccount};

use crate::{
    error::VaultError,
    events::{AuthorityTransferred, VaultStatusChanged, VaultSynced},
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, SolVault>,
}

#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, SolVault>,

    #[account(
        mut,
        constraint = wsol_vault.key() == vault.wsol_vault @ VaultError::InvalidWsolAccount,
        constraint = wsol_vault.mint == token::spl_token::native_mint::ID @ VaultError::InvalidWsolMint,
        constraint = wsol_vault.owner == vault.key() @ VaultError::InvalidWsolAccount,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,
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

pub fn sync(ctx: Context<Sync>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.balance_model == BalanceModel::Stored,
        VaultError::SyncNotRequired
    );

    let previous_total = vault.total_assets;
    let actual_balance = ctx.accounts.wsol_vault.amount;

    vault.total_assets = actual_balance;

    emit!(VaultSynced {
        vault: vault.key(),
        previous_total,
        new_total: actual_balance,
    });

    Ok(())
}
