use crate::constants::*;
use crate::error::*;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

#[derive(Accounts)]
pub struct RemoveChild<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,

    #[account(
        mut,
        close = authority,
        seeds = [CHILD_ALLOCATION_SEED, allocator_vault.key().as_ref(), child_vault.key().as_ref()],
        bump = child_allocation.bump,
        constraint = child_allocation.enabled @ VaultError::ChildAllocationDisabled,
    )]
    pub child_allocation: Account<'info, ChildAllocation>,

    // Safety account to verify 0 shares
    pub allocator_child_shares_account: Option<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Public key of the child vault being removed. Used only for PDA derivation.
    pub child_vault: UncheckedAccount<'info>,
}

pub fn remove_child_handler(ctx: Context<RemoveChild>) -> Result<()> {
    // 1. VALIDATION
    // Authority and enabled checks handled by Anchor constraints

    // Safety: cannot remove a child that still has shares or assets
    if ctx.accounts.child_allocation.child_shares_account != Pubkey::default() {
        require!(
            ctx.accounts.allocator_child_shares_account.is_some(),
            VaultError::InvalidRemainingAccounts
        );
        let shares_account = ctx
            .accounts
            .allocator_child_shares_account
            .as_ref()
            .unwrap();
        require!(
            shares_account.key() == ctx.accounts.child_allocation.child_shares_account,
            VaultError::Unauthorized
        );
        require!(shares_account.amount == 0, VaultError::ChildHasAssets);
    } else {
        require!(
            ctx.accounts.child_allocation.deposited_assets == 0,
            VaultError::ChildHasAssets
        );
    }

    // 6. UPDATE STATE
    // The account is closed, but we must update the total active children constraint:

    let allocator_vault = &mut ctx.accounts.allocator_vault;
    allocator_vault.num_children = allocator_vault
        .num_children
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT
    emit!(ChildRemoved {
        allocator_vault: allocator_vault.key(),
        child_vault: ctx.accounts.child_vault.key(),
    });

    Ok(())
}
