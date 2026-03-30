//! deposit_wsol: user transfers pre-wrapped wSOL → vault mints shares.
//!
//! This is the composability variant — protocols that already hold wSOL
//! can deposit without incurring the sync_native overhead.
//!
//! Flow:
//! 1. Read pre-deposit total_assets
//! 2. Compute shares (floor rounding)
//! 3. Slippage check
//! 4. transfer_checked (wSOL from user → wsol_vault)
//! 5. Mint shares to user
//! 6. Emit Deposit event

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{MIN_DEPOSIT_AMOUNT, SOL_VAULT_SEED},
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_shares, Rounding},
    state::SolVault,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct DepositWsol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// Native SOL mint — needed for transfer_checked
    #[account(address = crate::constants::NATIVE_MINT @ VaultError::Unauthorized)]
    pub native_mint: InterfaceAccount<'info, Mint>,

    /// User's wSOL token account (source of funds)
    #[account(
        mut,
        constraint = user_wsol_account.mint == native_mint.key(),
        constraint = user_wsol_account.owner == user.key(),
    )]
    pub user_wsol_account: InterfaceAccount<'info, TokenAccount>,

    /// Vault's wSOL token account (destination)
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
}

/// Deposit pre-wrapped wSOL and receive vault shares.
///
/// Preferred interface for protocol integrations that already hold wSOL.
/// No sync_native required — standard SPL transfer.
pub fn handler(ctx: Context<DepositWsol>, amount: u64, min_shares_out: u64) -> Result<()> {
    // 1. VALIDATION
    require!(amount > 0, VaultError::ZeroAmount);
    require!(amount >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    // 2. READ STATE (pre-transfer balance)
    let total_shares = ctx.accounts.shares_mint.supply;
    let vault = &ctx.accounts.vault;

    let total_assets = ctx.accounts.wsol_vault.amount;

    // ===== Module Hooks (if enabled) =====
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
            amount,
        )?;

        let shares = convert_to_shares(
            amount,
            total_assets,
            total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?;

        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    // 3. COMPUTE shares (floor rounding — favors vault)
    #[cfg(not(feature = "modules"))]
    let net_shares = convert_to_shares(
        amount,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // Prevent zero-share mint (full deposit loss)
    require!(net_shares > 0, VaultError::ZeroAmount);

    // 4. SLIPPAGE CHECK
    require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);

    // 5a. Transfer wSOL from user to vault (standard SPL transfer — no sync needed)
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_wsol_account.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
                mint: ctx.accounts.native_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.native_mint.decimals,
    )?;

    // Vault PDA signer seeds for mint_to
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[SOL_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    // 5b. Mint shares to user
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
        assets: amount,
        shares: net_shares,
    });

    Ok(())
}
