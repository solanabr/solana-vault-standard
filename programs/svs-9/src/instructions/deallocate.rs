use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
// Removed unused events import
use crate::error::*;

#[derive(Accounts)]
pub struct Deallocate<'info> {
    #[account(mut)]
    pub curator: Signer<'info>,

    #[account(
        mut,
        has_one = curator,
        constraint = !allocator_vault.paused @ VaultError::VaultPaused,
    )]
    pub allocator_vault: Box<Account<'info, AllocatorVault>>,

    #[account(
        mut,
        seeds = [CHILD_ALLOCATION_SEED, allocator_vault.key().as_ref(), child_vault.key().as_ref()],
        bump = child_allocation.bump,
    )]
    pub child_allocation: Box<Account<'info, ChildAllocation>>,

    #[account(
        mut,
        constraint = idle_vault.key() == allocator_vault.idle_vault @ VaultError::InvalidChildVault,
    )]
    pub idle_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Validated against child_allocation.child_vault
    #[account(
        mut,
        constraint = child_vault.key() == child_allocation.child_vault
            @ VaultError::InvalidChildVault,
    )]
    pub child_vault: UncheckedAccount<'info>,

    /// CHECK: Target SVS program ID. Checked to match child_allocation.child_program.
    #[account(
        constraint = child_program.key() == child_allocation.child_program @ VaultError::InvalidChildProgram
    )]
    pub child_program: UncheckedAccount<'info>,

    /// Account holding the shares the SVS-9 vault has in the child vault
    #[account(
        mut,
        constraint = allocator_child_shares_account.key() == child_allocation.child_shares_account @ VaultError::InvalidRemainingAccounts,
    )]
    pub allocator_child_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // --- External child vault accounts for CPI ---
    pub child_asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub child_asset_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub child_shares_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn deallocate_handler(
    ctx: Context<Deallocate>,
    shares_to_withdraw: u64,
    min_assets_out: u64,
) -> Result<()> {
    // 1. VALIDATION
    require!(shares_to_withdraw > 0, VaultError::ZeroAmount);

    let shares_before = ctx.accounts.allocator_child_shares_account.amount;
    require!(
        shares_to_withdraw <= shares_before,
        VaultError::InsufficientShares
    );

    // Initial idle balance to calculate actual assets received
    let idle_before = ctx.accounts.idle_vault.amount;

    // 5. EXECUTE CPIs
    // Invoke child_vault::redeem(shares_to_withdraw, min_assets_out)
    let asset_mint_key = ctx.accounts.allocator_vault.asset_mint;
    let vault_id_bytes = ctx.accounts.allocator_vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.allocator_vault.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        ALLOCATOR_VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &[bump],
    ]];

    let accounts = vec![
        AccountMeta::new(ctx.accounts.allocator_vault.key(), true),
        AccountMeta::new_readonly(ctx.accounts.child_vault.key(), false),
        AccountMeta::new_readonly(ctx.accounts.child_asset_mint.key(), false),
        AccountMeta::new(ctx.accounts.idle_vault.key(), false),
        AccountMeta::new(ctx.accounts.child_asset_vault.key(), false),
        AccountMeta::new(ctx.accounts.child_shares_mint.key(), false),
        AccountMeta::new(ctx.accounts.allocator_child_shares_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_2022_program.key(), false),
    ];

    let ix = crate::utils::build_child_redeem_ix(
        ctx.accounts.child_program.key(),
        accounts,
        shares_to_withdraw,
        min_assets_out,
    );

    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.allocator_vault.to_account_info(),
            ctx.accounts.child_vault.to_account_info(),
            ctx.accounts.child_asset_mint.to_account_info(),
            ctx.accounts.idle_vault.to_account_info(),
            ctx.accounts.child_asset_vault.to_account_info(),
            ctx.accounts.child_shares_mint.to_account_info(),
            ctx.accounts
                .allocator_child_shares_account
                .to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.token_2022_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    // 6. UPDATE STATE (Proportional reduction of deposited_assets)
    ctx.accounts.idle_vault.reload()?;
    let current_idle = ctx.accounts.idle_vault.amount;
    let assets_received = current_idle
        .checked_sub(idle_before)
        .ok_or(VaultError::MathOverflow)?;

    let child_allocation = &mut ctx.accounts.child_allocation;
    let shares_after = shares_before
        .checked_sub(shares_to_withdraw)
        .ok_or(VaultError::MathOverflow)?;

    // new_deposited = (cost_basis * remaining_shares) / initial_shares
    let new_deposited = (child_allocation.deposited_assets as u128)
        .checked_mul(shares_after as u128)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(shares_before as u128)
        .ok_or(VaultError::DivisionByZero)? as u64;

    child_allocation.deposited_assets = new_deposited;

    // 7. EMIT EVENT
    emit!(crate::events::Deallocate {
        allocator_vault: ctx.accounts.allocator_vault.key(),
        child_vault: ctx.accounts.child_vault.key(),
        shares_burned: shares_to_withdraw,
        assets_received,
    });

    Ok(())
}
