//! Admin instructions: pause, unpause, transfer authority, set vault operator.

use anchor_lang::prelude::*;

use crate::{
    error::VaultError,
    events::{
        AuthorityTransferRequested, AuthorityTransferred, CancelAfterChanged, MaxDeviationChanged,
        VaultOperatorChanged, VaultStatusChanged,
    },
    state::AsyncVault,
};

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Box<Account<'info, AsyncVault>>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        constraint = vault.pending_authority == new_authority.key() @ VaultError::InvalidPendingAuthority,
    )]
    pub vault: Box<Account<'info, AsyncVault>>,
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

/// Step 1: Request authority transfer. Sets pending_authority; the new authority
/// must call accept_authority to complete the transfer.
pub fn request_transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAddress
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
        VaultError::InvalidAddress
    );

    let vault = &mut ctx.accounts.vault;

    // Prevent silently overwriting a pending two-step transfer
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

pub fn set_max_deviation_bps(ctx: Context<Admin>, max_deviation_bps: u16) -> Result<()> {
    require!(max_deviation_bps > 0, VaultError::InvalidParameter);
    require!(max_deviation_bps <= 10_000, VaultError::InvalidParameter);

    ctx.accounts.vault.max_deviation_bps = max_deviation_bps;

    emit!(MaxDeviationChanged {
        vault: ctx.accounts.vault.key(),
        max_deviation_bps,
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
