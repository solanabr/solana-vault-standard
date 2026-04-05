use crate::{
    constants::MULTI_VAULT_SEED,
    error::VaultError,
    events::{AuthorityTransferRequested, AuthorityTransferred, VaultStatusChanged},
    state::MultiAssetVault,
};
use anchor_lang::prelude::*;

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    ctx.accounts.vault.paused = true;
    emit!(VaultStatusChanged {
        vault: ctx.accounts.vault.key(),
        paused: true,
    });
    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    require!(ctx.accounts.vault.paused, VaultError::VaultNotPaused);
    ctx.accounts.vault.paused = false;
    emit!(VaultStatusChanged {
        vault: ctx.accounts.vault.key(),
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

    // V4-P23: Prevent silently overwriting a pending two-step transfer
    require!(
        ctx.accounts.vault.pending_authority == Pubkey::default(),
        VaultError::PendingTransferExists
    );

    let previous = ctx.accounts.vault.authority;
    ctx.accounts.vault.authority = new_authority;
    ctx.accounts.vault.pending_authority = Pubkey::default();

    emit!(AuthorityTransferred {
        vault: ctx.accounts.vault.key(),
        previous_authority: previous,
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

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        mut,
        has_one = authority,
        seeds = [MULTI_VAULT_SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, MultiAssetVault>>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [MULTI_VAULT_SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
        constraint = vault.pending_authority == new_authority.key() @ VaultError::InvalidPendingAuthority,
    )]
    pub vault: Box<Account<'info, MultiAssetVault>>,
    pub new_authority: Signer<'info>,
}
