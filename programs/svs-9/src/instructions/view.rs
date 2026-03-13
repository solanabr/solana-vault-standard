//! View instructions for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::ALLOCATOR_VAULT_SEED,
    error::VaultError,
    math::total_assets,
    state::AllocatorVault,
};

#[derive(Accounts)]
pub struct AllocatorView<'info> {
    #[account(
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [b"idle_vault", allocator.key().as_ref()],
        bump,
        token::authority = allocator,
        token::mint = asset_mint,
    )]
    pub idle_vault: Box<Account<'info, TokenAccount>>,

    pub vault_id: u64,
}

pub fn total_assets(ctx: Context<AllocatorView>) -> Result<()> {
    let allocator = &ctx.accounts.allocator;
    let clock = Clock::get()?;

    // Check cache validity
    if allocator.is_cache_valid(clock.unix_timestamp) {
        // Return cached value
        anchor_lang::system_program::program::set_return_data(
            &allocator.cached_total_assets.to_le_bytes(),
        );
        return Ok(());
    }

    // Compute fresh total assets
    let total = total_assets(
        ctx.accounts.idle_vault.amount,
        &[],
        &[],
        &[],
        &[],
        allocator.decimals_offset,
    )?;

    // Update cache
    // Note: This is a view function, so we can't update the cache
    // In practice, this would be called by off-chain processes that cache the result

    anchor_lang::system_program::program::set_return_data(
        &total.to_le_bytes(),
    );

    Ok(())
}

#[derive(Accounts)]
pub struct ChildAllocationView<'info> {
    #[account(
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    /// CHECK: Child allocation account
    pub child_allocation: UncheckedAccount<'info>,

    pub vault_id: u64,
    pub child_vault: Pubkey,
}

pub fn child_allocation(ctx: Context<ChildAllocationView>) -> Result<()> {
    let allocator = &ctx.accounts.allocator;

    // Find child allocation for the specified child vault
    // In a real implementation, we'd need to iterate through child allocations
    // For this view function, we'll return the allocation if found
    
    if ctx.accounts.child_allocation.key() == Pubkey::default() {
        return Err(error!(VaultError::ChildNotFound));
    }

    // Return the allocation data
    let allocation_data = ctx.accounts.child_allocation.try_borrow_data()?;
    anchor_lang::system_program::program::set_return_data(allocation_data);

    Ok(())
}

#[derive(Accounts)]
pub struct MaxDeposit<'info> {
    #[account(
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    pub vault_id: u64,
}

pub fn max_deposit(ctx: Context<MaxDeposit>) -> Result<()> {
    let allocator = &ctx.accounts.allocator;
    
    // For simplicity, return u64::MAX as max deposit
    // In practice, this would consider global caps, per-user caps, etc.
    anchor_lang::system_program::program::set_return_data(&u64::MAX.to_le_bytes());

    Ok(())
}
