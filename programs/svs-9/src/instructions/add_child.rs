use anchor_lang::prelude::*;
use crate::state::*;
use crate::constants::*;
use crate::events::*;
use crate::error::*;

#[derive(Accounts)]
pub struct AddChild<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        constraint = allocator_vault.num_children < 10 @ VaultError::MathOverflow,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,

    #[account(
        init,
        payer = authority,
        space = 8 + ChildAllocation::INIT_SPACE,
        seeds = [CHILD_ALLOCATION_SEED, allocator_vault.key().as_ref(), child_vault.key().as_ref()],
        bump
    )]
    pub child_allocation: Account<'info, ChildAllocation>,

    /// CHECK: Public key of the vault being added as a child.
    /// The owner/program check is deferred to allocate/deallocate CPI time
    /// (allocate.rs: `child_vault.owner == &child_program.key()`), which is
    /// the correct enforcement point for live on-chain validation.
    pub child_vault: UncheckedAccount<'info>,

    /// CHECK: The program that owns the child vault. Stored for CPI verification.
    pub child_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn add_child_handler(ctx: Context<AddChild>, max_weight_bps: u16) -> Result<()> {
    // 1. VALIDATION
    // Max weight cannot exceed 100% (10,000 bps)
    require!(max_weight_bps <= 10000, VaultError::MathOverflow);

    // (READ STATE/COMPUTE/SLIPPAGE/CPIs - Not applicable for basic setup)

    // 6. UPDATE STATE
    // Initialize ChildAllocation
    let child_allocation = &mut ctx.accounts.child_allocation;
    let allocator_vault_key = ctx.accounts.allocator_vault.key();
    
    child_allocation.allocator_vault = allocator_vault_key;
    child_allocation.child_vault = ctx.accounts.child_vault.key();
    child_allocation.child_program = ctx.accounts.child_program.key();
    child_allocation.child_shares_account = Pubkey::default(); // Set during first allocate
    child_allocation.target_weight_bps = 0;
    child_allocation.max_weight_bps = max_weight_bps;
    child_allocation.deposited_assets = 0;
    child_allocation.index = ctx.accounts.allocator_vault.num_children; // pre-increment index
    child_allocation.enabled = true;
    child_allocation.bump = ctx.bumps.child_allocation;
    child_allocation._reserved = [0u8; 64];

    // Increment children count in AllocatorVault
    let allocator_vault = &mut ctx.accounts.allocator_vault;
    allocator_vault.num_children = allocator_vault.num_children.checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT
    emit!(ChildAddedEvent {
        allocator_vault: allocator_vault.key(),
        child_vault: ctx.accounts.child_vault.key(),
        child_program: ctx.accounts.child_program.key(),
        max_weight_bps,
    });

    Ok(())
}
