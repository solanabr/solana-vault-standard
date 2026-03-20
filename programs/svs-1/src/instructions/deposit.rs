//! Deposit instruction: transfer assets to vault, mint shares to user.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{MIN_DEPOSIT_AMOUNT, VAULT_SEED},
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_shares, Rounding},
    state::Vault,
};

#[cfg(feature = "modules")]
use crate::module_hooks;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Deposit assets and receive shares.
///
/// With modules feature enabled, pass module config PDAs via remaining_accounts:
/// - FeeConfig: applies entry fee (fee shares minted to fee_recipient later via collect_fees)
/// - CapConfig + UserDeposit: enforces global/per-user caps
/// - LockConfig + ShareLock: sets lock period on minted shares
/// - AccessConfig + FrozenAccount: access control checks
pub fn handler(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    // SVS-1: Use LIVE balance from asset_vault (not stored total_assets)
    // This prevents donation/inflation attacks without needing sync()
    let total_assets = ctx.accounts.asset_vault.amount;

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        // 1. Access control check (whitelist/blacklist + frozen)
        module_hooks::check_deposit_access(remaining, &vault_key, &user_key, &[])?;

        // 2. Cap enforcement
        module_hooks::check_deposit_caps(remaining, &vault_key, &user_key, total_assets, assets)?;

        // Calculate shares to mint (floor rounding - favors vault)
        let shares = convert_to_shares(
            assets,
            total_assets,
            total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?;

        // 3. Apply entry fee
        let result = module_hooks::apply_entry_fee(remaining, &vault_key, shares)?;
        result.net_shares
        // NOTE: fee_shares are not minted here - use collect_fees instruction
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = {
        // Calculate shares to mint (floor rounding - favors vault)
        convert_to_shares(
            assets,
            total_assets,
            total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?
    };

    // Slippage check (on net shares after fee)
    require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);

    // Transfer assets from user to vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_asset_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Prepare vault signer seeds
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // Mint net shares to user
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

    // NOTE: Entry fee shares NOT minted here - tracked in FeeConfig for later collection

    emit!(DepositEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares: net_shares,
    });

    Ok(())
}
