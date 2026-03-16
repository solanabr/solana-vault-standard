use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};
use crate::{constants::ALLOCATOR_SEED, error::AllocatorError, events::{Allocate, Deallocate}, math::{check_idle_buffer, validate_svs1_discriminator}, state::{AllocatorVault, ChildAllocation}};

pub fn allocate(ctx: Context<CuratorOp>, amount: u64) -> Result<()> {
    require!(amount > 0, AllocatorError::ZeroAmount);
    let child_data = ctx.accounts.child_vault.try_borrow_data()?;
    validate_svs1_discriminator(&child_data)?;
    require!(ctx.accounts.child_vault.key() == ctx.accounts.child_allocation.child_vault, AllocatorError::InvalidChildVault);
    drop(child_data);
    let idle_balance = ctx.accounts.idle_vault.amount;
    require!(idle_balance >= amount, AllocatorError::InsufficientLiquidity);
    let idle_after = idle_balance.checked_sub(amount).ok_or(AllocatorError::MathOverflow)?;
    check_idle_buffer(idle_after, idle_balance, ctx.accounts.allocator_vault.idle_buffer_bps)?;
    let vault = &ctx.accounts.allocator_vault;
    let vault_asset_mint = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[ALLOCATOR_SEED, vault_asset_mint.as_ref(), vault_id_bytes.as_ref(), &[bump]]];
    transfer_checked(CpiContext::new_with_signer(ctx.accounts.asset_token_program.to_account_info(), TransferChecked { from: ctx.accounts.idle_vault.to_account_info(), to: ctx.accounts.child_asset_vault.to_account_info(), mint: ctx.accounts.asset_mint.to_account_info(), authority: ctx.accounts.allocator_vault.to_account_info() }, signer_seeds), amount, ctx.accounts.asset_mint.decimals)?;
    ctx.accounts.child_allocation.deposited_assets = ctx.accounts.child_allocation.deposited_assets.checked_add(amount).ok_or(AllocatorError::MathOverflow)?;
    emit!(Allocate { allocator: ctx.accounts.allocator_vault.key(), child_vault: ctx.accounts.child_allocation.child_vault, assets_deployed: amount, child_shares_received: 0 });
    Ok(())
}

pub fn deallocate(ctx: Context<CuratorOp>, shares: u64) -> Result<()> {
    require!(shares > 0, AllocatorError::ZeroAmount);
    ctx.accounts.child_allocation.deposited_assets = ctx.accounts.child_allocation.deposited_assets.saturating_sub(shares);
    emit!(Deallocate { allocator: ctx.accounts.allocator_vault.key(), child_vault: ctx.accounts.child_allocation.child_vault, shares_redeemed: shares, assets_received: shares });
    Ok(())
}

#[derive(Accounts)]
pub struct CuratorOp<'info> {
    pub curator: Signer<'info>,
    #[account(constraint = allocator_vault.curator == curator.key() @ AllocatorError::UnauthorizedCurator, constraint = !allocator_vault.paused @ AllocatorError::VaultPaused)] pub allocator_vault: Account<'info, AllocatorVault>,
    #[account(mut, has_one = allocator_vault, constraint = child_allocation.enabled @ AllocatorError::ChildAllocationDisabled)] pub child_allocation: Account<'info, ChildAllocation>,
    /// CHECK: discriminator validated in handler
    pub child_vault: UncheckedAccount<'info>,
    #[account(mut)] pub child_asset_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, constraint = child_shares_account.key() == child_allocation.child_shares_account)] pub child_shares_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, constraint = idle_vault.key() == allocator_vault.idle_vault)] pub idle_vault: InterfaceAccount<'info, TokenAccount>,
    pub asset_mint: InterfaceAccount<'info, Mint>,
    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
