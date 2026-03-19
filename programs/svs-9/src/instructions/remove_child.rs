use anchor_lang::prelude::*;
use crate::state::*;
use crate::constants::*;
use crate::events::*;
use crate::error::*;

#[derive(Accounts)]
pub struct RemoveChild<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,

    #[account(
        mut,
        seeds = [CHILD_ALLOCATION_SEED, allocator_vault.key().as_ref(), child_vault.key().as_ref()],
        bump = child_allocation.bump,
        constraint = child_allocation.enabled @ VaultError::ChildAllocationDisabled,
    )]
    pub child_allocation: Account<'info, ChildAllocation>,

    /// CHECK: Public key of the child vault being removed. Used only for PDA derivation.
    pub child_vault: UncheckedAccount<'info>,
}

pub fn remove_child_handler(ctx: Context<RemoveChild>) -> Result<()> {
    // 1. VALIDATION
    // Authority and enabled checks handled by Anchor constraints

    // Safety: cannot remove a child that still has deposited assets
    require!(
        ctx.accounts.child_allocation.deposited_assets == 0,
        VaultError::ChildHasAssets
    );

    // 6. UPDATE STATE
    let child_allocation = &mut ctx.accounts.child_allocation;
    child_allocation.enabled = false;
    child_allocation.target_weight_bps = 0;
    child_allocation.max_weight_bps = 0;

    let allocator_vault = &mut ctx.accounts.allocator_vault;
    allocator_vault.num_children = allocator_vault.num_children.checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT
    emit!(ChildRemovedEvent {
        allocator_vault: allocator_vault.key(),
        child_vault: ctx.accounts.child_vault.key(),
    });

    Ok(())
}
