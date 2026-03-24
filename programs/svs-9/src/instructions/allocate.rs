use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
// Removed unused events import
use crate::error::*;

#[derive(Accounts)]
pub struct Allocate<'info> {
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

    /// CHECK: The child vault being deposited into. Checked by program CPI and owner check.
    #[account(
        mut,
        constraint = child_vault.owner == &child_program.key() @ VaultError::InvalidChildProgram
    )]
    pub child_vault: UncheckedAccount<'info>,

    /// CHECK: Target SVS program ID. Checked to match child_allocation.child_program.
    #[account(
        constraint = child_program.key() == child_allocation.child_program @ VaultError::InvalidChildProgram
    )]
    pub child_program: UncheckedAccount<'info>,

    // --- External child vault accounts for CPI ---
    pub child_asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub child_asset_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub child_shares_mint: Box<InterfaceAccount<'info, Mint>>,

    /// ATA of allocator_vault for receiving shares from the child vault
    #[account(mut)]
    pub allocator_child_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn allocate_handler(ctx: Context<Allocate>, assets: u64, min_shares_out: u64) -> Result<()> {
    // 1. VALIDATION
    require!(assets > 0, VaultError::ZeroAmount);

    let child_allocation = &mut ctx.accounts.child_allocation;
    require!(
        child_allocation.enabled,
        VaultError::ChildAllocationDisabled
    );

    // 2. READ STATE
    let total_assets_before = ctx.accounts.idle_vault.amount;

    // Buffer Rule: idle_after >= (total_assets * bps) / 10000
    // SVS-9 requires summing child vault positions by iterating over remaining_accounts.
    let total_assets = crate::utils::compute_total_assets(
        total_assets_before,
        ctx.accounts.allocator_vault.num_children,
        ctx.remaining_accounts,
    )?;

    // Weight enforcement: new weight cannot exceed max_weight_bps
    let (child_total_assets, child_total_shares) = crate::utils::read_child_live_balances(
        &ctx.accounts.child_asset_vault.to_account_info(),
        &ctx.accounts.child_shares_mint.to_account_info(),
    )?;

    // Retrieve child decimals offset statically saved in our PDA allocation wrapper
    let child_decimals_offset = child_allocation.child_decimals_offset;

    let current_market_value = if ctx.accounts.allocator_child_shares_account.amount > 0 {
        crate::math::convert_to_assets(
            ctx.accounts.allocator_child_shares_account.amount,
            child_total_assets,
            child_total_shares,
            child_decimals_offset,
            crate::math::Rounding::Floor,
        )?
    } else {
        0
    };

    let child_assets_after = current_market_value
        .checked_add(assets)
        .ok_or(VaultError::MathOverflow)?;
    let child_weight = (child_assets_after as u128)
        .checked_mul(10000)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(total_assets as u128)
        .ok_or(VaultError::DivisionByZero)? as u16;
    require!(
        child_weight <= child_allocation.max_weight_bps,
        VaultError::MaxWeightExceeded
    );

    let idle_after = total_assets_before
        .checked_sub(assets)
        .ok_or(VaultError::InsufficientAssets)?;

    let min_idle = (total_assets as u128)
        .checked_mul(ctx.accounts.allocator_vault.idle_buffer_bps as u128)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(10000)
        .ok_or(VaultError::DivisionByZero)? as u64;

    require!(idle_after >= min_idle, VaultError::InsufficientBuffer);

    // 5. EXECUTE CPIs
    // Invoke child_vault::deposit(assets, 0)
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
        AccountMeta::new(ctx.accounts.allocator_vault.key(), true), // caller (allocator_vault)
        AccountMeta::new_readonly(ctx.accounts.child_vault.key(), false),
        AccountMeta::new_readonly(ctx.accounts.child_asset_mint.key(), false),
        AccountMeta::new(ctx.accounts.idle_vault.key(), false), // user_asset_account
        AccountMeta::new(ctx.accounts.child_asset_vault.key(), false),
        AccountMeta::new(ctx.accounts.child_shares_mint.key(), false),
        AccountMeta::new(ctx.accounts.allocator_child_shares_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_2022_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
    ];

    let ix = crate::utils::build_child_deposit_ix(
        ctx.accounts.child_program.key(),
        accounts,
        assets,
        min_shares_out,
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
            ctx.accounts.associated_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    // 6. UPDATE STATE
    child_allocation.deposited_assets = child_allocation
        .deposited_assets
        .checked_add(assets)
        .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT
    emit!(crate::events::Allocate {
        allocator_vault: ctx.accounts.allocator_vault.key(),
        child_vault: ctx.accounts.child_vault.key(),
        assets,
    });

    Ok(())
}
