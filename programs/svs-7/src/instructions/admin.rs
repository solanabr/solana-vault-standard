//! Admin instructions: pause, unpause, transfer authority, sync.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    error::SolVaultError,
    events::{AuthorityTransferred, VaultStatusChanged, VaultSynced},
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ SolVaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, SolVault>,
}

/// Sync context requires the wSOL vault to read live balance.
#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ SolVaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, SolVault>,

    #[account(
        constraint = wsol_vault.key() == vault.wsol_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,
}

/// Pause all vault operations (emergency circuit breaker)
pub fn pause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(!vault.paused, SolVaultError::VaultPaused);

    vault.paused = true;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: true,
    });

    Ok(())
}

/// Unpause vault operations
pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.paused, SolVaultError::VaultNotPaused);

    vault.paused = false;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: false,
    });

    Ok(())
}

/// Transfer vault authority to new address
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

/// Sync total_assets to match actual wSOL vault balance (Stored model only).
/// This is how yield is distributed in the Stored model: an external strategy
/// deposits yield into the wSOL vault, then authority calls sync() to update
/// the accounting, which increases the share price for all holders.
pub fn sync(ctx: Context<Sync>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.balance_model == BalanceModel::Stored,
        SolVaultError::SyncNotSupported
    );

    let previous_total_assets = vault.total_assets;
    let new_total_assets = ctx.accounts.wsol_vault.amount;

    vault.total_assets = new_total_assets;

    emit!(VaultSynced {
        vault: vault.key(),
        previous_total_assets,
        new_total_assets,
    });

    Ok(())
}
