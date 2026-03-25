use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::events::{AuthorityTransferred, VaultStatusChanged};
use crate::state::ConfidentialStreamVault;

// ── Pause ──

#[derive(Accounts)]
pub struct Pause<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, ConfidentialStreamVault>,
}

pub fn pause(ctx: Context<Pause>) -> Result<()> {
    ctx.accounts.vault.paused = true;

    emit!(VaultStatusChanged {
        vault: ctx.accounts.vault.key(),
        paused: true,
    });

    Ok(())
}

// ── Unpause ──

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        constraint = vault.paused @ VaultError::VaultNotPaused,
    )]
    pub vault: Account<'info, ConfidentialStreamVault>,
}

pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    ctx.accounts.vault.paused = false;

    emit!(VaultStatusChanged {
        vault: ctx.accounts.vault.key(),
        paused: false,
    });

    Ok(())
}

// ── Transfer Authority ──
// Works even when paused (so a new authority can unpause).

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialStreamVault>,

    /// CHECK: The new authority. No validation needed — any pubkey is valid.
    pub new_authority: UncheckedAccount<'info>,
}

pub fn transfer_authority(ctx: Context<TransferAuthority>) -> Result<()> {
    let previous = ctx.accounts.vault.authority;
    ctx.accounts.vault.authority = ctx.accounts.new_authority.key();

    emit!(AuthorityTransferred {
        vault: ctx.accounts.vault.key(),
        previous_authority: previous,
        new_authority: ctx.accounts.new_authority.key(),
    });

    Ok(())
}
