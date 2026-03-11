//! Redeem instructions: burn exact shares to receive proportional assets.
//! redeem_sol: receives native SOL (unwrapped from wSOL).
//! redeem_wsol: receives wSOL directly.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{
        transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
    },
};

use crate::{
    constants::SOL_VAULT_SEED,
    error::SolVaultError,
    events::Withdraw as WithdrawEvent,
    math::{convert_to_assets, Rounding},
    state::{BalanceModel, SolVault},
};

use super::deposit::get_total_assets;

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

// =============================================================================
// redeem_sol: Burn shares, unwrap wSOL, send native SOL to user
// =============================================================================

#[derive(Accounts)]
pub struct RedeemSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ SolVaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// The native SOL mint
    pub asset_mint: InterfaceAccount<'info, Mint>,

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

    /// Temporary wSOL account owned by user, closed to unwrap SOL.
    #[account(
        mut,
        constraint = temp_wsol.mint == anchor_spl::token::spl_token::native_mint::id(),
        constraint = temp_wsol.owner == user.key(),
    )]
    pub temp_wsol: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Redeem shares for native SOL (floor rounding - protects vault).
pub fn redeem_sol_handler(
    ctx: Context<RedeemSol>,
    shares: u64,
    min_assets_out: u64,
) -> Result<()> {
    require!(shares > 0, SolVaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        SolVaultError::InsufficientShares
    );

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = get_total_assets(vault, &ctx.accounts.wsol_vault);

    // Calculate assets to receive (floor rounding - user gets less)
    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // Module hooks
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

    require!(net_assets >= min_assets_out, SolVaultError::SlippageExceeded);
    require!(assets <= total_assets, SolVaultError::InsufficientAssets);

    // Burn shares from user
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

    // Prepare vault signer seeds
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SOL_VAULT_SEED,
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // Transfer wSOL from vault to temp account
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.wsol_vault.to_account_info(),
                to: ctx.accounts.temp_wsol.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Close temp wSOL account to unwrap SOL to user
    anchor_spl::token_interface::close_account(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.temp_wsol.to_account_info(),
            destination: ctx.accounts.user.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    ))?;

    // Update stored balance if applicable
    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_sub(assets)
            .ok_or(SolVaultError::MathOverflow)?;
    }

    emit!(WithdrawEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets: net_assets,
        shares,
        is_native: true,
    });

    Ok(())
}

// =============================================================================
// redeem_wsol: Burn shares, transfer wSOL directly to user
// =============================================================================

#[derive(Accounts)]
pub struct RedeemWsol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ SolVaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// The native SOL mint
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// User's wSOL token account to receive assets
    #[account(
        mut,
        constraint = user_wsol_account.mint == anchor_spl::token::spl_token::native_mint::id(),
        constraint = user_wsol_account.owner == user.key(),
    )]
    pub user_wsol_account: InterfaceAccount<'info, TokenAccount>,

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

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Redeem shares for wSOL (floor rounding - protects vault).
pub fn redeem_wsol_handler(
    ctx: Context<RedeemWsol>,
    shares: u64,
    min_assets_out: u64,
) -> Result<()> {
    require!(shares > 0, SolVaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        SolVaultError::InsufficientShares
    );

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = get_total_assets(vault, &ctx.accounts.wsol_vault);

    // Calculate assets to receive (floor rounding - user gets less)
    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // Module hooks
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

    require!(net_assets >= min_assets_out, SolVaultError::SlippageExceeded);
    require!(assets <= total_assets, SolVaultError::InsufficientAssets);

    // Burn shares from user
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

    // Prepare vault signer seeds
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SOL_VAULT_SEED,
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // Transfer wSOL to user
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.wsol_vault.to_account_info(),
                to: ctx.accounts.user_wsol_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Update stored balance if applicable
    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_sub(assets)
            .ok_or(SolVaultError::MathOverflow)?;
    }

    emit!(WithdrawEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets: net_assets,
        shares,
        is_native: false,
    });

    Ok(())
}
