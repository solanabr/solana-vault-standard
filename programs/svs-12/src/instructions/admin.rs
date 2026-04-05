use anchor_lang::prelude::*;

use crate::{
    constants::TRANCHED_VAULT_SEED,
    error::VaultError,
    events::{
        AuthorityTransferRequested, AuthorityTransferred, ManagerChanged, VaultPaused,
        VaultUnpaused,
    },
    state::TranchedVault,
};

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Box<Account<'info, TranchedVault>>,
}

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    ctx.accounts.vault.paused = true;
    emit!(VaultPaused {
        vault: ctx.accounts.vault.key()
    });
    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    require!(ctx.accounts.vault.paused, VaultError::VaultNotPaused);
    ctx.accounts.vault.paused = false;
    emit!(VaultUnpaused {
        vault: ctx.accounts.vault.key()
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
        old_authority: previous_authority,
        new_authority,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        constraint = vault.pending_authority == new_authority.key() @ VaultError::InvalidPendingAuthority,
    )]
    pub vault: Box<Account<'info, TranchedVault>>,
}

/// Transfer vault authority (deprecated -- prefer two-step transfer).
#[allow(deprecated)]
#[deprecated(note = "Use request_transfer_authority + accept_authority two-step pattern")]
pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.vault.pending_authority == Pubkey::default(),
        VaultError::PendingTransferExists
    );

    let old_authority = ctx.accounts.vault.authority;
    ctx.accounts.vault.authority = new_authority;
    ctx.accounts.vault.pending_authority = Pubkey::default();

    emit!(AuthorityTransferred {
        vault: ctx.accounts.vault.key(),
        old_authority,
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

pub fn set_manager(ctx: Context<Admin>, new_manager: Pubkey) -> Result<()> {
    require!(new_manager != Pubkey::default(), VaultError::InvalidAddress);
    let old_manager = ctx.accounts.vault.manager;
    ctx.accounts.vault.manager = new_manager;
    emit!(ManagerChanged {
        vault: ctx.accounts.vault.key(),
        old_manager,
        new_manager,
    });
    Ok(())
}
