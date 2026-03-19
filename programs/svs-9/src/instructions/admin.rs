use anchor_lang::prelude::*;
use crate::state::*;
use crate::events::*;
use crate::error::*;

#[derive(Accounts)]
pub struct Pause<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,
}

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,
}

#[derive(Accounts)]
pub struct SetCurator<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,
}

pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
    vault.paused = true;
    
    emit!(VaultPausedEvent {
        vault: vault.key(),
    });
    
    Ok(())
}

pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
    vault.paused = false;
    
    emit!(VaultUnpausedEvent {
        vault: vault.key(),
    });
    
    Ok(())
}

pub fn transfer_authority(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
    let old_authority = vault.authority;
    vault.authority = new_authority;
    
    emit!(AuthorityTransferredEvent {
        vault: vault.key(),
        old_authority,
        new_authority,
    });
    
    Ok(())
}

pub fn set_curator(ctx: Context<SetCurator>, new_curator: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
    let old_curator = vault.curator;
    vault.curator = new_curator;
    
    emit!(CuratorTransferredEvent {
        vault: vault.key(),
        old_curator,
        new_curator,
    });
    
    Ok(())
}
