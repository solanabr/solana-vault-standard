use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
// Removed unused events import
use crate::error::*;
use crate::math::{convert_to_assets, mul_div, Rounding};

#[derive(Accounts)]
pub struct Harvest<'info> {
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

    /// CHECK: Target child vault from which yield will be harvested. Checked by program CPI.
    #[account(mut)]
    pub child_vault: UncheckedAccount<'info>,

    /// CHECK: Target SVS program ID. Checked to match child_allocation.child_program.
    #[account(
        constraint = child_program.key() == child_allocation.child_program @ VaultError::InvalidChildProgram
    )]
    pub child_program: UncheckedAccount<'info>,

    /// The idle vault where redeemed assets will be sent
    #[account(
        mut,
        constraint = idle_vault.key() == allocator_vault.idle_vault @ VaultError::InvalidChildVault,
    )]
    pub idle_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Shares the allocator holds in the child vault
    #[account(mut)]
    pub allocator_child_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // --- External child vault accounts for CPI ---
    pub child_asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub child_asset_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub child_shares_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn harvest_handler(ctx: Context<Harvest>, min_assets_out: u64) -> Result<()> {
    // 1. VALIDATION (via constraints)

    // 2. READ STATE — compute current value of our position in the child
    let (child_total_assets, child_total_shares) = crate::utils::read_child_live_balances(
        &ctx.accounts.child_asset_vault.to_account_info(),
        &ctx.accounts.child_shares_mint.to_account_info(),
    )?;

    // Retrieve child decimals offset statically saved in our PDA allocation wrapper
    let child_decimals_offset = ctx.accounts.child_allocation.child_decimals_offset;

    let our_shares = ctx.accounts.allocator_child_shares_account.amount;
    let current_value = convert_to_assets(
        our_shares,
        child_total_assets,
        child_total_shares,
        child_decimals_offset,
        Rounding::Floor,
    )?;

    let cost_basis = ctx.accounts.child_allocation.deposited_assets;

    // 3. COMPUTE — determine yield
    if current_value <= cost_basis || our_shares == 0 {
        // No yield to harvest
        return Ok(());
    }

    let yield_amount = current_value
        .checked_sub(cost_basis)
        .ok_or(VaultError::MathOverflow)?;

    // Calculate shares to redeem for the yield amount
    // shares_to_redeem = yield_amount * child_total_shares / child_total_assets
    if child_total_assets == 0 || child_total_shares == 0 {
        return Ok(());
    }

    // Round UP to favor the vault (burn enough shares to cover the yield completely).
    let shares_to_redeem = mul_div(
        yield_amount,
        child_total_shares,
        child_total_assets,
        Rounding::Ceiling,
    )?;

    // Cap at available shares
    let shares_to_redeem = shares_to_redeem.min(our_shares);

    if shares_to_redeem == 0 {
        return Ok(());
    }

    let idle_before = ctx.accounts.idle_vault.amount;

    // 5. EXECUTE CPI — child_vault::redeem(shares_to_redeem, 0)
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
        AccountMeta::new(ctx.accounts.allocator_vault.key(), true), // user
        AccountMeta::new_readonly(ctx.accounts.child_vault.key(), false), // vault
        AccountMeta::new_readonly(ctx.accounts.child_asset_mint.key(), false), // asset_mint
        AccountMeta::new(ctx.accounts.idle_vault.key(), false),     // user_asset_account
        AccountMeta::new(ctx.accounts.child_asset_vault.key(), false), // asset_vault
        AccountMeta::new(ctx.accounts.child_shares_mint.key(), false), // shares_mint
        AccountMeta::new(ctx.accounts.allocator_child_shares_account.key(), false), // user_shares_account
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false), // asset_token_program
        AccountMeta::new_readonly(ctx.accounts.token_2022_program.key(), false), // token_2022_program
    ];

    let ix = crate::utils::build_child_redeem_ix(
        ctx.accounts.child_program.key(),
        accounts,
        shares_to_redeem,
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

    // 6. UPDATE STATE
    ctx.accounts.idle_vault.reload()?;
    let assets_received = ctx
        .accounts
        .idle_vault
        .amount
        .checked_sub(idle_before)
        .ok_or(VaultError::MathOverflow)?;

    // After harvesting yield, the cost basis remains the same (we only took profit).
    // The shares decreased proportionally, so we update deposited_assets to reflect
    // that the remaining shares still track the original cost basis minus the redeemed portion.
    let shares_after = our_shares.checked_sub(shares_to_redeem).unwrap_or(0);
    let child_allocation = &mut ctx.accounts.child_allocation;

    if our_shares > 0 {
        let new_deposited = (child_allocation.deposited_assets as u128)
            .checked_mul(shares_after as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(our_shares as u128)
            .ok_or(VaultError::DivisionByZero)? as u64;
        child_allocation.deposited_assets = new_deposited;
    }

    // 7. EMIT EVENT
    emit!(crate::events::Harvest {
        allocator_vault: ctx.accounts.allocator_vault.key(),
        child_vault: ctx.accounts.child_vault.key(),
        yield_realized: assets_received,
    });

    Ok(())
}
