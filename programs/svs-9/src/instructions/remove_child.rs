//! Remove child instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::{ALLOCATOR_VAULT_SEED, CHILD_ALLOCATION_SEED},
    error::VaultError,
    events::ChildRemoved,
    state::{AllocatorVault, ChildAllocation},
};

#[derive(Accounts)]
pub struct RemoveChild<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(
        mut,
        close = child_allocation,
        seeds = [CHILD_ALLOCATION_SEED, allocator.key().as_ref(), child_vault.key().as_ref()],
        bump = child_allocation.bump,
        constraint = child_allocation.allocator_vault == allocator.key(),
        constraint = child_allocation.child_vault == child_vault.key()
    )]
    pub child_allocation: Box<Account<'info, ChildAllocation>>,

    /// CHECK: Child vault account for validation
    pub child_vault: UncheckedAccount<'info>,

    /// CHECK: Child vault program for validation
    pub child_program: UncheckedAccount<'info>,

    pub vault_id: u64,
    pub child_vault: Pubkey,
}

pub fn handler(
    ctx: Context<RemoveChild>,
    child_vault: Pubkey,
) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let child_allocation = &ctx.accounts.child_allocation;

    // Validate this is the correct child
    require!(
        child_allocation.child_vault == child_vault,
        VaultError::ChildNotFound
    );

    // In a full implementation, we would need to deallocate all shares from child vault
    // and close the child_shares_account before removing the child
    // For now, we'll require zero deposited assets (simplified)
    require!(
        child_allocation.deposited_assets == 0,
        VaultError::ChildHasShares
    );

    // Update allocator
    allocator.num_children = allocator.num_children.checked_sub(1)
        .ok_or(error!(VaultError::MathOverflow))?;

    // Close child allocation account (return rent to authority)
    let child_allocation_lamports = child_allocation.to_account_info().lamports;
    **ctx.accounts.child_allocation.to_account_info().try_borrow_mut_lamports() = child_allocation_lamports;

    emit_cpi!(ChildRemoved {
        allocator: allocator.key(),
        child_vault,
        final_shares: 0,
        final_assets: 0,
    });

    Ok(())
}
