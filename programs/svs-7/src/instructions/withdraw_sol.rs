//! withdraw_sol: burn shares to withdraw exact lamports as native SOL.
//!
//! wSOL unwrap pattern:
//! 1. Burn user shares
//! 2. transfer_checked (wSOL from wsol_vault → user's wSOL account, vault PDA signs)
//! 3. close_account (user's wSOL account → native SOL to user, user signs)
//!
//! The user provides their wSOL account. After receiving wSOL from the vault,
//! we close it so lamports arrive as native SOL. The user is already a signer
//! so they can authorize the close.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, CloseAccount, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::SOL_VAULT_SEED,
    error::VaultError,
    events::Withdraw as WithdrawEvent,
    math::{convert_to_shares, Rounding},
    state::SolVault,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// Native SOL mint — needed for transfer_checked
    #[account(address = crate::constants::NATIVE_MINT @ VaultError::Unauthorized)]
    pub native_mint: InterfaceAccount<'info, Mint>,

    /// Vault's wSOL token account (source)
    #[account(
        mut,
        constraint = wsol_vault.key() == vault.wsol_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    /// User's wSOL token account (temporary landing pad for unwrap).
    /// The user owns this account (authority = user). After receiving
    /// wSOL from the vault, we close it and native SOL goes to `user`.
    #[account(
        mut,
        constraint = user_wsol_account.mint == native_mint.key(),
        constraint = user_wsol_account.owner == user.key(),
    )]
    pub user_wsol_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// SPL Token program (wSOL uses spl-token, NOT token-2022)
    #[account(address = anchor_spl::token::ID @ VaultError::Unauthorized)]
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Withdraw exact lamports by burning vault shares, receiving native SOL.
///
/// Shares required are computed with ceiling rounding (protects vault).
/// Slippage guard: shares_required <= max_shares_in.
///
/// Exit fee behavior (modules feature): shares are computed from the gross withdrawal
/// amount (`lamports`), but the user receives `net_lamports` (after fee deduction).
/// This means withdraw(X) burns shares worth X but delivers X minus fee.
/// This is a codebase-wide design decision consistent with other SVS vault types.
/// Integrators should call preview_withdraw to determine actual assets received.
pub fn handler(ctx: Context<WithdrawSol>, lamports: u64, max_shares_in: u64) -> Result<()> {
    // 1. VALIDATION
    require!(lamports > 0, VaultError::ZeroAmount);

    // 2. READ STATE
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    let total_assets = ctx.accounts.wsol_vault.amount;

    require!(lamports <= total_assets, VaultError::InsufficientAssets);

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_lamports = {
        let remaining = ctx.remaining_accounts;
        let clock = Clock::get()?;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_share_lock(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            clock.unix_timestamp,
        )?;

        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, lamports)?;
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let net_lamports = lamports;

    // 3. COMPUTE shares to burn (ceiling rounding — user burns more, protects vault)
    let shares = convert_to_shares(
        lamports,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    // 4. SLIPPAGE CHECK
    require!(shares <= max_shares_in, VaultError::SlippageExceeded);

    // Check user has enough shares
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    // 5a. Burn shares from user (user is authority)
    token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // Vault PDA signer seeds
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[SOL_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    // 5b. Transfer wSOL from vault to user's wSOL account (vault PDA signs)
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.wsol_vault.to_account_info(),
                to: ctx.accounts.user_wsol_account.to_account_info(),
                mint: ctx.accounts.native_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_lamports,
        ctx.accounts.native_mint.decimals,
    )?;

    // 5c. Close user's wSOL account — unwraps wSOL to native SOL, lamports go to user
    // User is authority on their wSOL account and is a signer on this tx.
    token_2022::close_account(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.user_wsol_account.to_account_info(),
            destination: ctx.accounts.user.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    ))?;

    // 6. EMIT EVENT
    emit!(WithdrawEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets: net_lamports,
        shares,
    });

    Ok(())
}
