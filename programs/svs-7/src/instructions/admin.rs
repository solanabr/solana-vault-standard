//! Admin instructions: pause, unpause, two-step authority transfer.

use anchor_lang::prelude::*;

use crate::{
    constants::SOL_VAULT_SEED,
    error::VaultError,
    events::{AuthorityTransferRequested, AuthorityTransferred, VaultStatusChanged},
    state::SolVault,
};

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, SolVault>>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.pending_authority == new_authority.key() @ VaultError::InvalidPendingAuthority,
    )]
    pub vault: Box<Account<'info, SolVault>>,
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

/// Step 1: Request authority transfer. Sets pending_authority; the new authority
/// must call accept_authority to complete the transfer.
pub fn request_transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAuthority
    );

    let vault = &mut ctx.accounts.vault;

    // V9-P8: Prevent silently overwriting a pending transfer
    require!(
        vault.pending_authority == Pubkey::default(),
        VaultError::PendingTransferExists
    );

    vault.pending_authority = new_authority;

    emit!(AuthorityTransferRequested {
        vault: vault.key(),
        current_authority: vault.authority,
        pending_authority: new_authority,
    });

    Ok(())
}

/// Step 2: Accept authority transfer. Must be signed by the pending authority.
pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.pending_authority != Pubkey::default(),
        VaultError::NoPendingTransfer
    );

    let previous_authority = vault.authority;
    let new_authority = vault.pending_authority;

    vault.authority = new_authority;
    vault.pending_authority = Pubkey::default();

    emit!(AuthorityTransferred {
        vault: vault.key(),
        previous_authority,
        new_authority,
    });

    Ok(())
}

/// Direct transfer authority (deprecated -- prefer request_transfer_authority + accept_authority)
#[allow(deprecated)]
#[deprecated(note = "Use request_transfer_authority + accept_authority two-step pattern")]
pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAuthority
    );

    let vault = &mut ctx.accounts.vault;

    // V4-P23: Prevent silently overwriting a pending two-step transfer
    require!(
        vault.pending_authority == Pubkey::default(),
        VaultError::PendingTransferExists
    );

    let previous_authority = vault.authority;

    vault.authority = new_authority;
    vault.pending_authority = Pubkey::default();

    emit!(AuthorityTransferred {
        vault: vault.key(),
        previous_authority,
        new_authority,
    });

    Ok(())
}

/// Cancel a pending two-step authority transfer.
pub fn cancel_transfer_authority(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.pending_authority != Pubkey::default(),
        VaultError::NoPendingTransfer
    );

    vault.pending_authority = Pubkey::default();

    Ok(())
}
