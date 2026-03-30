use crate::constants::*;
use crate::error::*;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateWeights<'info> {
    pub authority: Signer<'info>,

    #[account(
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

    /// CHECK: Public key of the child vault. Used only for PDA derivation.
    pub child_vault: UncheckedAccount<'info>,
}

pub fn update_weights_handler(ctx: Context<UpdateWeights>, new_max_weight_bps: u16) -> Result<()> {
    // 1. VALIDATION
    require!(new_max_weight_bps <= 10000, VaultError::MathOverflow);

    // 6. UPDATE STATE
    let child_allocation = &mut ctx.accounts.child_allocation;
    let old_max_weight_bps = child_allocation.max_weight_bps;
    child_allocation.max_weight_bps = new_max_weight_bps;

    // 7. EMIT EVENT
    emit!(WeightsUpdated {
        allocator_vault: ctx.accounts.allocator_vault.key(),
        child_vault: ctx.accounts.child_vault.key(),
        old_max_weight_bps,
        new_max_weight_bps,
    });

    Ok(())
}
