use anchor_lang::prelude::*;
use crate::{error::AllocatorError, events::*, state::AllocatorVault, constants::MAX_IDLE_BUFFER_BPS};

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    require!(!ctx.accounts.allocator_vault.paused, AllocatorError::VaultPaused);
    ctx.accounts.allocator_vault.paused = true;
    emit!(AllocatorStatusChanged { vault: ctx.accounts.allocator_vault.key(), paused: true });
    Ok(())
}
pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    require!(ctx.accounts.allocator_vault.paused, AllocatorError::VaultNotPaused);
    ctx.accounts.allocator_vault.paused = false;
    emit!(AllocatorStatusChanged { vault: ctx.accounts.allocator_vault.key(), paused: false });
    Ok(())
}
pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
    let previous = vault.authority;
    vault.authority = new_authority;
    emit!(AuthorityTransferred { vault: vault.key(), previous_authority: previous, new_authority });
    Ok(())
}
pub fn set_curator(ctx: Context<Admin>, new_curator: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.allocator_vault;
    let previous = vault.curator;
    vault.curator = new_curator;
    emit!(CuratorChanged { vault: vault.key(), previous_curator: previous, new_curator });
    Ok(())
}
pub fn update_idle_buffer(ctx: Context<Admin>, idle_buffer_bps: u16) -> Result<()> {
    require!(idle_buffer_bps < MAX_IDLE_BUFFER_BPS, AllocatorError::InvalidIdleBuffer);
    let vault = &mut ctx.accounts.allocator_vault;
    let old_bps = vault.idle_buffer_bps;
    vault.idle_buffer_bps = idle_buffer_bps;
    emit!(IdleBufferUpdated { vault: vault.key(), old_bps, new_bps: idle_buffer_bps });
    Ok(())
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ AllocatorError::Unauthorized)]
    pub allocator_vault: Account<'info, AllocatorVault>,
}
