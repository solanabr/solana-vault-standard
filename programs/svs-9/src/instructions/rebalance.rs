use crate::constants::*;
use crate::error::*;
use crate::events::*;
use crate::math::Rounding;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[derive(Accounts)]
pub struct Rebalance<'info> {
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
        constraint = child_allocation.enabled @ VaultError::ChildAllocationDisabled,
    )]
    pub child_allocation: Box<Account<'info, ChildAllocation>>,

    #[account(
        mut,
        constraint = idle_vault.key() == allocator_vault.idle_vault @ VaultError::InvalidChildVault,
    )]
    pub idle_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: The child vault for deposit/withdraw CPI. Checked by program CPI.
    #[account(mut)]
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

    /// ATA of allocator_vault for shares in the child vault
    #[account(mut)]
    pub allocator_child_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn rebalance_handler(ctx: Context<Rebalance>, min_out: u64) -> Result<()> {
    // 1. VALIDATION (curator + paused + enabled checked by constraints)

    // 2. READ STATE
    let idle_amount = ctx.accounts.idle_vault.amount;
    let total_assets = crate::utils::compute_total_assets(
        idle_amount,
        ctx.accounts.allocator_vault.num_children,
        ctx.remaining_accounts,
    )?;

    if total_assets == 0 {
        return Ok(());
    }

    let idle_buffer_bps = ctx.accounts.allocator_vault.idle_buffer_bps as u128;

    // Compute ideal idle balance from the buffer rule
    let ideal_idle = (total_assets as u128)
        .checked_mul(idle_buffer_bps)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(10000)
        .ok_or(VaultError::DivisionByZero)? as u64;

    // 3. COMPUTE — decide if we need to deposit or withdraw
    let asset_mint_key = ctx.accounts.allocator_vault.asset_mint;
    let vault_id_bytes = ctx.accounts.allocator_vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.allocator_vault.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        ALLOCATOR_VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &[bump],
    ]];

    if idle_amount > ideal_idle {
        // --- EXCESS IDLE: deposit surplus into the child vault ---
        let surplus = idle_amount
            .checked_sub(ideal_idle)
            .ok_or(VaultError::MathOverflow)?;

        let child_allocation = &mut ctx.accounts.child_allocation;

        // Weight enforcement: cap surplus so child weight doesn't exceed max_weight_bps
        // This mirrors the identical check in allocate.rs
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
            .checked_add(surplus)
            .ok_or(VaultError::MathOverflow)?;
        let _child_weight_after = (child_assets_after as u128)
            .checked_mul(10000)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(total_assets as u128)
            .ok_or(VaultError::DivisionByZero)? as u16;

        // Compute max deposit allowed by the weight cap
        let max_allowed = (total_assets as u128)
            .checked_mul(child_allocation.max_weight_bps as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(10000)
            .ok_or(VaultError::DivisionByZero)? as u64;

        // Respect both the weight cap and the available capacity
        let available_capacity = max_allowed.saturating_sub(current_market_value);
        let actual_surplus = surplus.min(available_capacity);

        if actual_surplus == 0 {
            return Ok(());
        }

        // 5. EXECUTE CPI — child_vault::deposit(actual_surplus, 0)
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
            AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ];

        let ix = crate::utils::build_child_deposit_ix(
            ctx.accounts.child_program.key(),
            accounts,
            actual_surplus,
            min_out,
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
            .checked_add(actual_surplus)
            .ok_or(VaultError::MathOverflow)?;

        // 7. EMIT EVENT
        emit!(crate::events::Rebalance {
            allocator_vault: ctx.accounts.allocator_vault.key(),
            child_vault: ctx.accounts.child_vault.key(),
            action: RebalanceAction::Deposit,
            amount: actual_surplus,
        });
    } else if idle_amount < ideal_idle {
        // --- DEFICIT: withdraw from child vault to restore the buffer ---
        let deficit = ideal_idle
            .checked_sub(idle_amount)
            .ok_or(VaultError::MathOverflow)?;

        // Compute how many shares to redeem for the deficit amount
        let shares_held = ctx.accounts.allocator_child_shares_account.amount;
        if shares_held == 0 {
            return Ok(());
        }

        // Estimate shares needed: shares = deficit * total_shares / total_assets_in_child
        // Read directly from the token accounts to support live balance vaults (like SVS-1)
        let child_total_assets = ctx.accounts.child_asset_vault.amount;
        let child_total_shares = ctx.accounts.child_shares_mint.supply;

        if child_total_assets == 0 || child_total_shares == 0 {
            return Ok(());
        }

        let shares_to_redeem = crate::math::mul_div(
            deficit,
            child_total_shares,
            child_total_assets,
            Rounding::Ceiling,
        )?;
        let shares_to_redeem = shares_to_redeem.min(shares_held);

        let idle_before = ctx.accounts.idle_vault.amount;

        // 5. EXECUTE CPI — child_vault::redeem(shares_to_redeem, 0)
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
            min_out,
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

        // 6. UPDATE STATE (proportional reduction of deposited_assets)
        ctx.accounts.idle_vault.reload()?;
        let assets_received = ctx
            .accounts
            .idle_vault
            .amount
            .checked_sub(idle_before)
            .ok_or(VaultError::MathOverflow)?;

        let child_allocation = &mut ctx.accounts.child_allocation;
        let shares_after = shares_held.checked_sub(shares_to_redeem).unwrap_or(0);

        if shares_held > 0 {
            let new_deposited = (child_allocation.deposited_assets as u128)
                .checked_mul(shares_after as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(shares_held as u128)
                .ok_or(VaultError::DivisionByZero)? as u64;
            child_allocation.deposited_assets = new_deposited;
        }

        // 7. EMIT EVENT
        emit!(crate::events::Rebalance {
            allocator_vault: ctx.accounts.allocator_vault.key(),
            child_vault: ctx.accounts.child_vault.key(),
            action: RebalanceAction::Withdraw,
            amount: assets_received,
        });
    }
    // If idle == ideal, nothing to do

    Ok(())
}
