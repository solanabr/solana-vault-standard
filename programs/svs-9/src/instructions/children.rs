use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};
use crate::{constants::{CHILD_ALLOCATION_SEED, MAX_CHILDREN}, error::AllocatorError, events::*, math::validate_svs1_discriminator, state::{AllocatorVault, ChildAllocation}};

pub fn add_child(ctx: Context<AddChild>, target_weight_bps: u16, max_weight_bps: u16) -> Result<()> {
    require!(ctx.accounts.allocator_vault.num_children < MAX_CHILDREN as u8, AllocatorError::MaxChildrenReached);
    require!(target_weight_bps <= 10_000, AllocatorError::InvalidWeight);
    require!(max_weight_bps <= 10_000 && max_weight_bps >= target_weight_bps, AllocatorError::InvalidWeight);
    let child_data = ctx.accounts.child_vault.try_borrow_data()?;
    validate_svs1_discriminator(&child_data)?;
    drop(child_data);
    let index = ctx.accounts.allocator_vault.num_children;
    let child_alloc = &mut ctx.accounts.child_allocation;
    child_alloc.allocator_vault = ctx.accounts.allocator_vault.key();
    child_alloc.child_vault = ctx.accounts.child_vault.key();
    child_alloc.child_program = ctx.accounts.child_program.key();
    child_alloc.child_shares_account = ctx.accounts.child_shares_account.key();
    child_alloc.target_weight_bps = target_weight_bps;
    child_alloc.max_weight_bps = max_weight_bps;
    child_alloc.deposited_assets = 0;
    child_alloc.index = index;
    child_alloc.enabled = true;
    child_alloc.bump = ctx.bumps.child_allocation;
    ctx.accounts.allocator_vault.num_children = ctx.accounts.allocator_vault.num_children.checked_add(1).ok_or(AllocatorError::MathOverflow)?;
    emit!(ChildAdded { allocator: ctx.accounts.allocator_vault.key(), child_vault: ctx.accounts.child_vault.key(), child_program: ctx.accounts.child_program.key(), target_weight_bps, max_weight_bps, index });
    Ok(())
}

pub fn remove_child(ctx: Context<RemoveChild>) -> Result<()> {
    let index = ctx.accounts.child_allocation.index;
    emit!(ChildRemoved { allocator: ctx.accounts.allocator_vault.key(), child_vault: ctx.accounts.child_allocation.child_vault, index });
    Ok(())
}

pub fn update_weights(ctx: Context<UpdateWeights>, target_weight_bps: u16, max_weight_bps: u16) -> Result<()> {
    require!(target_weight_bps <= 10_000 && max_weight_bps <= 10_000 && max_weight_bps >= target_weight_bps, AllocatorError::InvalidWeight);
    let child = &mut ctx.accounts.child_allocation;
    let (old_target, old_max) = (child.target_weight_bps, child.max_weight_bps);
    child.target_weight_bps = target_weight_bps;
    child.max_weight_bps = max_weight_bps;
    emit!(ChildWeightsUpdated { allocator: ctx.accounts.allocator_vault.key(), child_vault: child.child_vault, old_target_bps: old_target, new_target_bps: target_weight_bps, old_max_bps: old_max, new_max_bps: max_weight_bps });
    Ok(())
}

pub fn toggle_child(ctx: Context<ToggleChild>, enabled: bool) -> Result<()> {
    ctx.accounts.child_allocation.enabled = enabled;
    emit!(ChildToggled { allocator: ctx.accounts.allocator_vault.key(), child_vault: ctx.accounts.child_allocation.child_vault, enabled });
    Ok(())
}

#[derive(Accounts)]
pub struct AddChild<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ AllocatorError::Unauthorized)] pub allocator_vault: Account<'info, AllocatorVault>,
    /// CHECK: discriminator validated in handler
    pub child_vault: UncheckedAccount<'info>,
    /// CHECK: validated against child_vault.owner
    pub child_program: UncheckedAccount<'info>,
    #[account(constraint = child_shares_account.owner == allocator_vault.key())] pub child_shares_account: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = authority, space = ChildAllocation::LEN, seeds = [CHILD_ALLOCATION_SEED, allocator_vault.key().as_ref(), child_vault.key().as_ref()], bump)] pub child_allocation: Account<'info, ChildAllocation>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveChild<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ AllocatorError::Unauthorized)] pub allocator_vault: Account<'info, AllocatorVault>,
    #[account(mut, has_one = allocator_vault, close = authority)] pub child_allocation: Account<'info, ChildAllocation>,
    #[account(constraint = child_shares_account.key() == child_allocation.child_shares_account, constraint = child_shares_account.amount == 0 @ AllocatorError::ChildHasShares)] pub child_shares_account: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateWeights<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority @ AllocatorError::Unauthorized)] pub allocator_vault: Account<'info, AllocatorVault>,
    #[account(mut, has_one = allocator_vault)] pub child_allocation: Account<'info, ChildAllocation>,
}

#[derive(Accounts)]
pub struct ToggleChild<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority @ AllocatorError::Unauthorized)] pub allocator_vault: Account<'info, AllocatorVault>,
    #[account(mut, has_one = allocator_vault)] pub child_allocation: Account<'info, ChildAllocation>,
}
