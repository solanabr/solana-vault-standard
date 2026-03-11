//! Admin instructions: pause, unpause, sync, transfer_authority.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::SOL_VAULT_SEED,
    error::VaultError,
    events::{AuthorityTransferred, VaultStatusChanged, VaultSynced},
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, SolVault>,
}

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    ctx.accounts.vault.paused = true;
    emit!(VaultStatusChanged { vault: ctx.accounts.vault.key(), paused: true });
    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    require!(ctx.accounts.vault.paused, VaultError::VaultNotPaused);
    ctx.accounts.vault.paused = false;
    emit!(VaultStatusChanged { vault: ctx.accounts.vault.key(), paused: false });
    Ok(())
}

pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    let previous = ctx.accounts.vault.authority;
    ctx.accounts.vault.authority = new_authority;
    emit!(AuthorityTransferred {
        vault: ctx.accounts.vault.key(),
        previous_authority: previous,
        new_authority,
    });
    Ok(())
}

// ─── sync ─────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Sync<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, SolVault>,

    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,
}

pub fn sync(ctx: Context<Sync>) -> Result<()> {
    require!(
        ctx.accounts.vault.balance_model == BalanceModel::Stored,
        VaultError::NotStoredModel
    );
    require!(
        ctx.accounts.wsol_vault.key() == ctx.accounts.vault.wsol_vault,
        VaultError::InvalidAccount
    );
    let new_total = ctx.accounts.wsol_vault.amount;
    ctx.accounts.vault.total_assets = new_total;
    emit!(VaultSynced { vault: ctx.accounts.vault.key(), total_assets: new_total });
    Ok(())
}
