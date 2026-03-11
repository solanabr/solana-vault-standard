//! Admin instructions: pause, unpause, sync, transfer authority.
//!
//! sync() is only valid for the Stored balance model and updates
//! total_assets from the actual wSOL vault balance.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

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

/// Accounts for the sync instruction (Stored model only).
#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, SolVault>,

    /// wSOL vault — source of truth for actual balance
    #[account(
        constraint = wsol_vault.key() == vault.wsol_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,
}

/// Pause all vault operations (emergency circuit breaker)
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

/// Unpause vault operations
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

/// Transfer vault authority to a new address
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

/// Sync vault.total_assets with the actual wSOL vault balance.
///
/// Only valid for the Stored balance model. Allows the authority to push
/// external yield (staking rewards, donations) into the vault's accounting
/// without requiring users to transact.
pub fn sync(ctx: Context<Sync>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.balance_model == BalanceModel::Stored,
        VaultError::SyncNotAllowed
    );

    let previous_total = vault.total_assets;
    let new_total = ctx.accounts.wsol_vault.amount;

    vault.total_assets = new_total;

    emit!(VaultSynced {
        vault: vault.key(),
        previous_total,
        new_total,
    });

    Ok(())
}
