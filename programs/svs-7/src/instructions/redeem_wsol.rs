//! redeem_wsol: burn exact shares to receive proportional wSOL (no unwrap).
//!
//! Composability variant — user receives wSOL directly.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::SOL_VAULT_SEED,
    error::VaultError,
    events::Withdraw as WithdrawEvent,
    math::{convert_to_assets, Rounding},
    state::SolVault,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct RedeemWsol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// Native SOL mint — needed for transfer_checked
    #[account(address = crate::constants::NATIVE_MINT @ VaultError::Unauthorized)]
    pub native_mint: InterfaceAccount<'info, Mint>,

    /// User's wSOL token account (destination — receives wSOL, no unwrap)
    #[account(
        mut,
        constraint = user_wsol_account.mint == native_mint.key(),
        constraint = user_wsol_account.owner == user.key(),
    )]
    pub user_wsol_account: InterfaceAccount<'info, TokenAccount>,

    /// Vault's wSOL token account (source)
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
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// SPL Token program (wSOL uses spl-token, NOT token-2022)
    #[account(address = anchor_spl::token::ID @ VaultError::Unauthorized)]
    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Redeem exact shares for wSOL (floor rounding — protects vault).
pub fn handler(ctx: Context<RedeemWsol>, shares: u64, min_assets_out: u64) -> Result<()> {
    // 1. VALIDATION
    require!(shares > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    // 2. READ STATE
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    let total_assets = ctx.accounts.wsol_vault.amount;

    // 3. COMPUTE assets (floor rounding — user gets less, protects vault)
    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_assets = {
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

        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, assets)?;
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let net_assets = assets;

    // 4. SLIPPAGE CHECK
    require!(net_assets > 0, VaultError::ZeroAmount);
    require!(net_assets >= min_assets_out, VaultError::SlippageExceeded);
    require!(assets <= total_assets, VaultError::InsufficientAssets);

    // 5. Burn shares
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

    // 6. Transfer wSOL from vault to user (no close — user receives wSOL)
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
        net_assets,
        ctx.accounts.native_mint.decimals,
    )?;

    // 7. EMIT EVENT
    emit!(WithdrawEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets: net_assets,
        shares,
    });

    Ok(())
}
