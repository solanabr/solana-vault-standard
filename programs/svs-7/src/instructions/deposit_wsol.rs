//! Deposit wSOL instruction: accept pre-wrapped wSOL, mint shares (no wrapping needed).

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{MIN_DEPOSIT_AMOUNT, SOL_VAULT_SEED},
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_shares, Rounding},
    state::{BalanceModel, SolVault},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct DepositWsol<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// Native mint (wSOL)
    pub native_mint: InterfaceAccount<'info, Mint>,

    /// User's wSOL token account
    #[account(
        mut,
        constraint = user_wsol_account.mint == anchor_spl::token::spl_token::native_mint::id(),
        constraint = user_wsol_account.owner == depositor.key(),
    )]
    pub user_wsol_account: InterfaceAccount<'info, TokenAccount>,

    /// Vault's wSOL token account
    #[account(
        mut,
        constraint = wsol_vault.key() == vault.wsol_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    /// Shares mint (Token-2022)
    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    /// User's shares token account - create if needed
    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = shares_mint,
        associated_token::authority = depositor,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// Token program for wSOL transfers
    pub wsol_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Deposit pre-wrapped wSOL: standard SPL transfer → mint shares.
/// No wrapping needed — for protocol composability.
pub fn handler(ctx: Context<DepositWsol>, amount: u64, min_shares_out: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    require!(amount >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    // Read total_assets based on balance model
    let total_assets = match vault.balance_model {
        BalanceModel::Live => ctx.accounts.wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    };

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.depositor.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            total_assets,
            amount,
        )?;
    }

    // Compute shares (floor rounding — user gets fewer shares)
    let shares = convert_to_shares(
        amount,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    #[cfg(feature = "modules")]
    let net_shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let result =
            module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = shares;

    // Slippage check
    require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);

    // Transfer wSOL from user to vault (standard SPL transfer)
    transfer_checked(
        CpiContext::new(
            ctx.accounts.wsol_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_wsol_account.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
                mint: ctx.accounts.native_mint.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.native_mint.decimals,
    )?;

    // Mint shares to user
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SOL_VAULT_SEED,
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

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

    // Update stored balance if applicable
    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(DepositEvent {
        vault: vault.key(),
        caller: ctx.accounts.depositor.key(),
        owner: ctx.accounts.depositor.key(),
        assets: amount,
        shares: net_shares,
        is_native: false,
    });

    Ok(())
}
