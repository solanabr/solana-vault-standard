//! Mint SOL instruction: mint exact shares by paying native SOL.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::SOL_VAULT_SEED,
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_assets, Rounding},
    state::{BalanceModel, SolVault},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct MintSol<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
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
        init_if_needed,
        payer = depositor,
        associated_token::mint = shares_mint,
        associated_token::authority = depositor,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub wsol_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Mint exact shares, paying required native SOL (ceiling rounding — protects vault).
pub fn handler(ctx: Context<MintSol>, shares: u64, max_lamports_in: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    let total_assets = match vault.balance_model {
        BalanceModel::Live => ctx.accounts.wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    };

    // Calculate required lamports (ceiling rounding — user pays more)
    let lamports = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_shares = {
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
            lamports,
        )?;

        let result =
            module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = shares;

    // Slippage check
    require!(lamports <= max_lamports_in, VaultError::SlippageExceeded);

    // Transfer native SOL from user to wsol_vault
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
            },
        ),
        lamports,
    )?;

    // Sync native to update wSOL token balance
    let sync_ix = anchor_spl::token_2022::spl_token_2022::instruction::sync_native(
        &ctx.accounts.wsol_token_program.key(),
        &ctx.accounts.wsol_vault.key(),
    )?;
    anchor_lang::solana_program::program::invoke(
        &sync_ix,
        &[ctx.accounts.wsol_vault.to_account_info()],
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

    // Update stored balance
    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_add(lamports)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(DepositEvent {
        vault: vault.key(),
        caller: ctx.accounts.depositor.key(),
        owner: ctx.accounts.depositor.key(),
        assets: lamports,
        shares: net_shares,
        is_native: true,
    });

    Ok(())
}
