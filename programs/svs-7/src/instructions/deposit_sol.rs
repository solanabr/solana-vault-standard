//! deposit_sol: user transfers native SOL → vault wraps to wSOL → mints shares.
//!
//! Flow:
//! 1. system_program::transfer (user → wsol_vault lamports)
//! 2. sync_native (update wSOL token account balance)
//! 3. wsol_vault.reload() to get fresh amount
//! 4. compute shares using pre-deposit total_assets
//! 5. slippage check
//! 6. mint shares to user
//! 7. emit Deposit event

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{Mint, TokenAccount, TokenInterface},
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
pub struct DepositSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// wSOL token account owned by the vault PDA
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

    /// User's shares token account — created if it doesn't exist yet
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// SPL Token program (wSOL uses spl-token, NOT token-2022)
    #[account(address = anchor_spl::token::ID @ VaultError::Unauthorized)]
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Deposit native SOL and receive vault shares.
///
/// The user sends lamports directly. The vault wraps them to wSOL internally
/// via sync_native so no pre-wrapping is required by the caller.
pub fn handler(ctx: Context<DepositSol>, lamports: u64, min_shares_out: u64) -> Result<()> {
    // 1. VALIDATION
    require!(lamports > 0, VaultError::ZeroAmount);
    require!(lamports >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    // 2. READ STATE (pre-deposit total_assets — BEFORE the transfer)
    let total_shares = ctx.accounts.shares_mint.supply;
    let vault = &ctx.accounts.vault;

    // Read balance BEFORE the deposit so CPIs do not alter the amount used for share math.
    let pre_deposit_total_assets = ctx.accounts.wsol_vault.amount;

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
            pre_deposit_total_assets,
            lamports,
        )?;

        // 3. COMPUTE shares (before transfers so we use pre-deposit state)
        let shares = convert_to_shares(
            lamports,
            pre_deposit_total_assets,
            total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?;

        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    // 3. COMPUTE shares (floor rounding — favors vault)
    let net_shares = convert_to_shares(
        lamports,
        pre_deposit_total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // Prevent zero-share mint (full deposit loss)
    require!(net_shares > 0, VaultError::ZeroAmount);

    // 4. SLIPPAGE CHECK
    require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);

    // 5a. Transfer native SOL from user to vault's wSOL account (lamport balance only)
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
            },
        ),
        lamports,
    )?;

    // 5b. sync_native: update the wSOL token account's `amount` to match its lamport balance
    let sync_ix = spl_token_2022::instruction::sync_native(
        ctx.accounts.token_program.key,
        ctx.accounts.wsol_vault.to_account_info().key,
    )?;
    invoke(
        &sync_ix,
        &[ctx.accounts.wsol_vault.to_account_info()],
    )?;

    // 5c. Reload wSOL account data after sync so subsequent reads are accurate
    ctx.accounts.wsol_vault.reload()?;

    // Prepare vault PDA signer seeds for mint_to
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SOL_VAULT_SEED,
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

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
        assets: lamports,
        shares: net_shares,
    });

    Ok(())
}
