use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, transfer_checked, TransferChecked};
use anchor_spl::token_2022::{self, Token2022};
use crate::state::*;
use crate::constants::*;
use crate::events::*;
use crate::error::*;
use crate::math::calculate_shares;

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: The user who will receive the minted allocator shares
    pub owner: UncheckedAccount<'info>,

    #[account(
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
        constraint = caller_asset_account.owner == caller.key(),
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
    
    /// Token-2022 program for shares
    pub token_2022_program: Program<'info, Token2022>,
    
    pub system_program: Program<'info, System>,
}

/// Deposit assets and receive allocator shares.
///
/// With modules feature enabled, pass module config PDAs via remaining_accounts:
/// - FeeConfig: applies entry fee (fee shares tracked for later collection)
/// - CapConfig + UserDeposit: enforces global/per-user deposit caps
/// - AccessConfig + FrozenAccount: access control whitelist/blacklist checks
pub fn deposit_handler(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
    // 1. VALIDATION
    require!(assets > 0, VaultError::ZeroAmount);

    // 2. READ STATE
    let total_shares = ctx.accounts.shares_mint.supply;
    let num_children = ctx.accounts.allocator_vault.num_children as usize;

    let child_accounts_len = num_children * 5;
    let all_remaining = ctx.remaining_accounts;
    require!(
        all_remaining.len() >= child_accounts_len,
        VaultError::InvalidRemainingAccounts
    );
    let (child_accounts, _module_accounts) = all_remaining.split_at(child_accounts_len);

    // 3. COMPUTE
    let total_assets = crate::utils::compute_total_assets(
        ctx.accounts.idle_vault.amount,
        ctx.accounts.allocator_vault.num_children,
        child_accounts
    )?;
    
    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_shares = {
        let remaining = module_accounts;
        let vault_key = ctx.accounts.allocator_vault.key();
        let user_key = ctx.accounts.caller.key();

        // 1. Access control check (whitelist/blacklist + frozen)
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;

        // 2. Cap enforcement
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            total_assets,
            assets,
        )?;

        // Calculate shares
        let shares = calculate_shares(assets, total_assets, total_shares, ctx.accounts.allocator_vault.decimals_offset)?;

        // 3. Apply entry fee
        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = calculate_shares(assets, total_assets, total_shares, ctx.accounts.allocator_vault.decimals_offset)?;

    // 4. SLIPPAGE CHECK (on net shares after fee)
    require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);
    require!(net_shares > 0, VaultError::ZeroAmount);

    // 5. EXECUTE CPIs
    // 5.1 Transfer assets from caller to idle_vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.caller_asset_account.to_account_info(),
                to: ctx.accounts.idle_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.caller.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 5.2 Mint allocator shares to owner using stored bump
    let asset_mint_key = ctx.accounts.allocator_vault.asset_mint;
    let vault_id_bytes = ctx.accounts.allocator_vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.allocator_vault.bump;
    
    let signer_seeds: &[&[&[u8]]] = &[&[
        ALLOCATOR_VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &[bump],
    ]];

    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_2022::MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.owner_shares_account.to_account_info(),
                authority: ctx.accounts.allocator_vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_shares,
    )?;

    // 6. UPDATE STATE
    // (no local state needs updating, child vault balances and share mint supply are updated via CPI)

    // 7. EMIT EVENT
    emit!(DepositEvent {
        vault: ctx.accounts.allocator_vault.key(),
        caller: ctx.accounts.caller.key(),
        owner: ctx.accounts.owner.key(),
        assets,
        shares: net_shares,
    });

    Ok(())
}
