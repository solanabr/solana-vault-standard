//! Update weights instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::{ALLOCATOR_VAULT_SEED, CHILD_ALLOCATION_SEED},
    error::VaultError,
    events::WeightsUpdated,
    state::{AllocatorVault, ChildAllocation},
    math::validate_weight,
};

#[derive(Accounts)]
pub struct UpdateWeights<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [CHILD_ALLOCATION_SEED, allocator.key().as_ref(), child_vault.key().as_ref()],
        bump,
        constraint = child_allocation.allocator_vault == allocator.key(),
        constraint = child_allocation.child_vault == child_vault.key()
    )]
    pub child_allocation: Box<Account<'info, ChildAllocation>>,

    /// CHECK: Child vault account for validation
    pub child_vault: UncheckedAccount<'info>,

    pub vault_id: u64,
    pub child_vault: Pubkey,
    pub target_weight_bps: Option<u16>,
    pub max_weight_bps: Option<u16>,
}

pub fn handler(
    ctx: Context<UpdateWeights>,
    child_vault: Pubkey,
    target_weight_bps: Option<u16>,
    max_weight_bps: Option<u16>,
) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let child_allocation = &mut ctx.accounts.child_allocation;

    // Validate this is the correct child
    require!(
        child_allocation.child_vault == child_vault,
        VaultError::ChildNotFound
    );

    let old_target_weight = child_allocation.target_weight_bps;
    let old_max_weight = child_allocation.max_weight_bps;

    // Update weights if provided
    if let Some(target) = target_weight_bps {
        validate_weight(target)?;
        child_allocation.target_weight_bps = target;
    }

    if let Some(max_weight) = max_weight_bps {
        validate_weight(max_weight)?;
        child_allocation.max_weight_bps = max_weight;
    }

    // Ensure max >= target
    require!(
        child_allocation.max_weight_bps >= child_allocation.target_weight_bps,
        VaultError::InvalidWeight
    );

    emit_cpi!(WeightsUpdated {
        allocator: allocator.key(),
        child_vault,
        old_target_weight_bps,
        new_target_weight_bps: child_allocation.target_weight_bps,
        old_max_weight_bps,
        new_max_weight_bps: child_allocation.max_weight_bps,
    });

    Ok(())
}
