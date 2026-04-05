use crate::error::*;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Box<Account<'info, AllocatorVault>>,
}

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
    require!(!vault.paused, VaultError::VaultPaused);
    vault.paused = true;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: true,
    });

    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
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

    let vault = &mut ctx.accounts.allocator_vault;

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
    let vault = &mut ctx.accounts.allocator_vault;

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

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        constraint = allocator_vault.pending_authority == new_authority.key() @ VaultError::InvalidPendingAuthority,
    )]
    pub allocator_vault: Box<Account<'info, AllocatorVault>>,
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
        ctx.accounts.allocator_vault.pending_authority == Pubkey::default(),
        VaultError::PendingTransferExists
    );

    let vault = &mut ctx.accounts.allocator_vault;
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
    let vault = &mut ctx.accounts.allocator_vault;
    require!(
        vault.pending_authority != Pubkey::default(),
        VaultError::NoPendingTransfer
    );

    vault.pending_authority = Pubkey::default();

    Ok(())
}

pub fn set_curator(ctx: Context<Admin>, new_curator: Pubkey) -> Result<()> {
    require!(new_curator != Pubkey::default(), VaultError::InvalidAddress);
    let vault = &mut ctx.accounts.allocator_vault;
    let old_curator = vault.curator;
    vault.curator = new_curator;

    emit!(CuratorTransferred {
        vault: vault.key(),
        old_curator,
        new_curator,
    });

    Ok(())
}
