//! Admin instructions: pause, unpause, sync, transfer authority.

use anchor_lang::prelude::*;

use crate::{
    constants::SOL_VAULT_SEED,
    error::VaultError,
    events::{AuthorityTransferred, VaultStatusChanged, VaultSynced},
    state::{BalanceModel, SolVault},
};

use anchor_spl::token_interface::{TokenAccount, TokenInterface};

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
    /// Anyone can call sync (permissionless)
    pub caller: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    #[account(
        constraint = wsol_vault.key() == vault.wsol_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    pub wsol_token_program: Interface<'info, TokenInterface>,
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

/// Sync stored total_assets with live wSOL vault balance.
/// Only available for Stored balance model (SVS-7 with stored balances).
/// Permissionless — anyone can call.
pub fn sync(ctx: Context<Sync>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.balance_model == BalanceModel::Stored,
        VaultError::SyncNotAvailableLiveModel
    );

    let previous_total_assets = vault.total_assets;
    let live_balance = ctx.accounts.wsol_vault.amount;

    vault.total_assets = live_balance;

    emit!(VaultSynced {
        vault: vault.key(),
        previous_total_assets,
        new_total_assets: live_balance,
    });

    Ok(())
}
