//! Add child instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::{ALLOCATOR_VAULT_SEED, CHILD_ALLOCATION_SEED},
    error::VaultError,
    events::ChildAdded,
    state::{AllocatorVault, ChildAllocation},
    math::validate_weight,
};

#[derive(Accounts)]
pub struct AddChild<'info> {
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
        init,
        payer = authority,
        space = ChildAllocation::LEN,
        seeds = [CHILD_ALLOCATION_SEED, allocator.key().as_ref(), child_vault.key().as_ref()],
        bump
    )]
    pub child_allocation: Box<Account<'info, ChildAllocation>>,

    /// CHECK: Child vault account to validate
    pub child_vault: UncheckedAccount<'info>,

    /// CHECK: Child vault program for validation
    pub child_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct AddChildParams {
    pub vault_id: u64,
    pub child_vault: Pubkey,
    pub child_program: Pubkey,
    pub target_weight_bps: u16,
    pub max_weight_bps: u16,
}

pub fn handler(ctx: Context<AddChild>, params: AddChildParams) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;

    // Validate inputs
    require!(
        allocator.num_children < crate::constants::MAX_CHILDREN,
        VaultError::TooManyChildren
    );
    crate::math::validate_weight(params.target_weight_bps)?;
    crate::math::validate_weight(params.max_weight_bps)?;
    require!(
        params.target_weight_bps <= params.max_weight_bps,
        VaultError::InvalidWeight
    );

    // Initialize child allocation
    let child_allocation = &mut ctx.accounts.child_allocation;
    child_allocation.allocator_vault = allocator.key();
    child_allocation.child_vault = params.child_vault;
    child_allocation.child_program = params.child_program;
    child_allocation.child_shares_account = Pubkey::default(); // Will be set on first allocation
    child_allocation.target_weight_bps = params.target_weight_bps;
    child_allocation.max_weight_bps = params.max_weight_bps;
    child_allocation.deposited_assets = 0;
    child_allocation.index = allocator.num_children;
    child_allocation.enabled = true;
    child_allocation.bump = ctx.bumps.child_allocation;

    // Update allocator
    allocator.num_children = allocator.num_children.checked_add(1)
        .ok_or(error!(VaultError::MathOverflow))?;

    emit_cpi!(ChildAdded {
        allocator: allocator.key(),
        child_vault: params.child_vault,
        child_program: params.child_program,
        target_weight_bps: params.target_weight_bps,
        max_weight_bps: params.max_weight_bps,
        index: child_allocation.index,
    });

    Ok(())
}
