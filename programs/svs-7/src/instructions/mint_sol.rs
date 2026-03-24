//! mint_sol: user mints an exact number of shares by paying native SOL.
//!
//! Flow:
//! 1. Read pre-deposit total_assets
//! 2. Compute required lamports (ceiling rounding)
//! 3. Slippage check (assets <= max_lamports_in)
//! 4. system_program::transfer (user → wsol_vault)
//! 5. sync_native + reload
//! 6. Mint shares to user
//! 7. Emit Deposit event

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::{
    token_2022::{self, MintTo, Token2022},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{MIN_DEPOSIT_AMOUNT, SOL_VAULT_SEED},
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_assets, Rounding},
    state::SolVault,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct MintSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    #[account(
        mut,
        constraint = wsol_vault.key() == vault.wsol_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == shares_mint.key(),
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// SPL Token program (wSOL uses spl-token, NOT token-2022)
    #[account(address = anchor_spl::token::ID @ VaultError::Unauthorized)]
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Mint an exact number of shares by paying native SOL.
///
/// Required assets are computed with ceiling rounding (protects vault).
/// Slippage guard: assets_required <= max_lamports_in.
pub fn handler(ctx: Context<MintSol>, shares: u64, max_lamports_in: u64) -> Result<()> {
    // 1. VALIDATION
    require!(shares > 0, VaultError::ZeroAmount);

    // 2. READ STATE (pre-deposit)
    let total_shares = ctx.accounts.shares_mint.supply;
    let vault = &ctx.accounts.vault;

    let total_assets = ctx.accounts.wsol_vault.amount;

    // 3. COMPUTE required lamports from FULL shares (ceiling rounding — protects vault)
    let required_lamports = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    // ===== Module Hooks: access → caps → fee (matches SVS-1 ordering) =====
    #[cfg(feature = "modules")]
    let net_shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            total_assets,
            required_lamports,
        )?;

        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = shares;

    // Zero-share guard after fee application
    require!(net_shares > 0, VaultError::ZeroAmount);

    // 4. MINIMUM DEPOSIT CHECK
    require!(required_lamports > 0, VaultError::ZeroAmount);
    require!(required_lamports >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    // 5. SLIPPAGE CHECK — user wants at most max_lamports_in spent
    require!(required_lamports <= max_lamports_in, VaultError::SlippageExceeded);

    // 5a. Transfer native SOL from user to vault's wSOL account
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
            },
        ),
        required_lamports,
    )?;

    // 5b. sync_native to update wSOL token account balance
    let sync_ix = spl_token_2022::instruction::sync_native(
        ctx.accounts.token_program.key,
        ctx.accounts.wsol_vault.to_account_info().key,
    )?;
    invoke(&sync_ix, &[ctx.accounts.wsol_vault.to_account_info()])?;

    // 5c. Reload wSOL account data
    ctx.accounts.wsol_vault.reload()?;

    // Vault PDA signer seeds
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[SOL_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    // 5d. Mint shares to user
    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_shares,
    )?;

    // 6. EMIT EVENT
    emit!(DepositEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets: required_lamports,
        shares: net_shares,
    });

    Ok(())
}
