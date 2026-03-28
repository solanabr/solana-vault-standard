use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, Token2022};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::*;
use crate::math::{convert_to_assets, Rounding};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = !allocator_vault.paused @ VaultError::VaultPaused,
    )]
    pub allocator_vault: Box<Account<'info, AllocatorVault>>,

    #[account(
        mut,
        constraint = idle_vault.key() == allocator_vault.idle_vault @ VaultError::InvalidChildVault,
    )]
    pub idle_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = shares_mint.key() == allocator_vault.shares_mint @ VaultError::InvalidChildVault,
    )]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = caller_asset_account.mint == asset_mint.key(),
    )]
    pub caller_asset_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_shares_account.mint == shares_mint.key(),
        constraint = owner_shares_account.owner == owner.key(),
    )]
    pub owner_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Token program for asset (supports SPL and Token-2022)
    pub token_program: Interface<'info, TokenInterface>,

    /// Token-2022 program for burning shares
    pub token_2022_program: Program<'info, Token2022>,
}

/// Redeem shares for underlying assets.
///
/// With modules feature enabled, pass module config PDAs via remaining_accounts:
/// - LockConfig + ShareLock: checks if shares are still locked
/// - FeeConfig: applies exit fee (fee retained in vault for later collection)
/// - AccessConfig + FrozenAccount: access control checks
pub fn redeem_handler(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()> {
    // 1. VALIDATION
    require!(shares > 0, VaultError::ZeroAmount);

    // 2. READ STATE
    let total_shares = ctx.accounts.shares_mint.supply;
    let num_children = ctx.accounts.allocator_vault.num_children as usize;

    let child_accounts_len = num_children * 5;
    let all_remaining = ctx.remaining_accounts;
    require!(
        all_remaining.len() >= child_accounts_len,
        VaultError::InvalidRemainingAccounts
    );
    let (child_accounts, _) = all_remaining.split_at(child_accounts_len);

    // 3. COMPUTE
    let total_assets = crate::utils::compute_total_assets(
        ctx.accounts.idle_vault.amount,
        ctx.accounts.allocator_vault.num_children,
        child_accounts,
        ctx.accounts.allocator_vault.key(),
    )?;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        ctx.accounts.allocator_vault.decimals_offset,
        Rounding::Floor,
    )?;

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_assets = {
        let (_, modules) = all_remaining.split_at(child_accounts_len);
        let clock = Clock::get()?;
        let vault_key = ctx.accounts.allocator_vault.key();
        let user_key = ctx.accounts.caller.key();

        // 1. Lock check - ensure shares are not locked
        module_hooks::check_share_lock(
            modules,
            &crate::ID,
            &vault_key,
            &user_key,
            clock.unix_timestamp,
        )?;

        // 2. Apply exit fee
        let result = module_hooks::apply_exit_fee(modules, &crate::ID, &vault_key, assets)?;
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let net_assets = assets;

    // 4. SLIPPAGE CHECK (on net assets after fee)
    require!(net_assets >= min_assets_out, VaultError::SlippageExceeded);
    require!(net_assets > 0, VaultError::ZeroAmount);

    // Liquidity Rule
    require!(
        ctx.accounts.idle_vault.amount >= net_assets,
        VaultError::InsufficientAssets
    );

    // 5. EXECUTE CPIs
    // 5.1 Burn allocator shares from owner
    token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            token_2022::Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.owner_shares_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        shares,
    )?;

    // 5.2 Transfer net assets from idle_vault to caller using stored bump
    let asset_mint_key = ctx.accounts.allocator_vault.asset_mint;
    let vault_id_bytes = ctx.accounts.allocator_vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.allocator_vault.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        ALLOCATOR_VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &[bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.idle_vault.to_account_info(),
                to: ctx.accounts.caller_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.allocator_vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 6. UPDATE STATE
    let vault = &mut ctx.accounts.allocator_vault;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares)
        .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT
    emit!(crate::events::Withdraw {
        vault: ctx.accounts.allocator_vault.key(),
        caller: ctx.accounts.caller.key(),
        owner: ctx.accounts.owner.key(),
        assets: net_assets,
        shares,
    });

    Ok(())
}
