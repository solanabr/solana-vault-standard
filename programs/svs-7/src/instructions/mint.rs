//! Mint instructions: mint exact shares by depositing required assets.
//! mint_sol: pay with native SOL.
//! mint_wsol: pay with pre-wrapped wSOL.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::SOL_VAULT_SEED,
    error::SolVaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_assets, Rounding},
    state::{BalanceModel, SolVault},
};

use super::deposit::{get_total_assets, sync_native_cpi};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

// =============================================================================
// mint_sol: Mint exact shares, pay with native SOL
// =============================================================================

#[derive(Accounts)]
pub struct MintSharesSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ SolVaultError::VaultPaused,
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
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Mint exact shares, paying native SOL (ceiling rounding on assets - protects vault).
pub fn mint_sol_handler(
    ctx: Context<MintSharesSol>,
    shares: u64,
    max_assets_in: u64,
) -> Result<()> {
    require!(shares > 0, SolVaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = get_total_assets(vault, &ctx.accounts.wsol_vault);

    // Calculate required assets (ceiling rounding - user pays more)
    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    // Module hooks
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
            assets,
        )?;

        let result =
            module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = shares;

    require!(assets <= max_assets_in, SolVaultError::SlippageExceeded);

    // 1. Transfer native SOL from user to the wSOL vault account
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
            },
        ),
        assets,
    )?;

    // 2. Sync native balance
    sync_native_cpi(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.wsol_vault.to_account_info(),
    )?;

    // 3. Reload wsol_vault after CPI
    ctx.accounts.wsol_vault.reload()?;

    // 4. Prepare vault signer seeds
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SOL_VAULT_SEED,
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // 5. Mint shares to user
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

    // 6. Update stored balance if applicable
    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_add(assets)
            .ok_or(SolVaultError::MathOverflow)?;
    }

    emit!(DepositEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares: net_shares,
        is_native: true,
    });

    Ok(())
}

// =============================================================================
// mint_wsol: Mint exact shares, pay with pre-wrapped wSOL
// =============================================================================

#[derive(Accounts)]
pub struct MintSharesWsol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ SolVaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// The native SOL mint
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// User's wSOL token account
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
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Mint exact shares, paying wSOL (ceiling rounding on assets - protects vault).
pub fn mint_wsol_handler(
    ctx: Context<MintSharesWsol>,
    shares: u64,
    max_assets_in: u64,
) -> Result<()> {
    require!(shares > 0, SolVaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = get_total_assets(vault, &ctx.accounts.wsol_vault);

    // Calculate required assets (ceiling rounding - user pays more)
    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    // Module hooks
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
            assets,
        )?;

        let result =
            module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = shares;

    require!(assets <= max_assets_in, SolVaultError::SlippageExceeded);

    // 1. Transfer wSOL from user to vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_wsol_account.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 2. Prepare vault signer seeds
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SOL_VAULT_SEED,
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // 3. Mint shares to user
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

    // 4. Update stored balance if applicable
    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_add(assets)
            .ok_or(SolVaultError::MathOverflow)?;
    }

    emit!(DepositEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares: net_shares,
        is_native: false,
    });

    Ok(())
}
