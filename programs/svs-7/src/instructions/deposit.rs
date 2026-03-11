//! Deposit instructions: deposit_sol (native SOL) and deposit_wsol (pre-wrapped wSOL).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{MIN_DEPOSIT_AMOUNT, SOL_VAULT_SEED},
    error::SolVaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_shares, Rounding},
    state::{BalanceModel, SolVault},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

// =============================================================================
// deposit_sol: Accept native SOL, wrap internally
// =============================================================================

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

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
        payer = depositor,
        associated_token::mint = shares_mint,
        associated_token::authority = depositor,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Deposit native SOL: transfer lamports to wSOL vault, sync_native, mint shares.
pub fn deposit_sol_handler(
    ctx: Context<DepositSol>,
    lamports: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(lamports > 0, SolVaultError::ZeroAmount);
    require!(lamports >= MIN_DEPOSIT_AMOUNT, SolVaultError::DepositTooSmall);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    // Read total assets BEFORE deposit
    let total_assets = get_total_assets(vault, &ctx.accounts.wsol_vault);

    // 1. Transfer native SOL from depositor to the wSOL vault account
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
            },
        ),
        lamports,
    )?;

    // 2. Sync native balance so wSOL token account reflects the new lamport balance
    sync_native_cpi(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.wsol_vault.to_account_info(),
    )?;

    // 3. Reload wsol_vault after CPI
    ctx.accounts.wsol_vault.reload()?;

    // 4. Compute shares (floor rounding - favors vault)
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

        let shares = convert_to_shares(
            lamports,
            total_assets,
            total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?;

        let result =
            module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = convert_to_shares(
        lamports,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(net_shares >= min_shares_out, SolVaultError::SlippageExceeded);

    // 5. Mint shares to depositor
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
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

    // 6. Update stored balance if applicable
    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_add(lamports)
            .ok_or(SolVaultError::MathOverflow)?;
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

// =============================================================================
// deposit_wsol: Accept pre-wrapped wSOL
// =============================================================================

#[derive(Accounts)]
pub struct DepositWsol<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

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
        constraint = user_wsol_account.owner == depositor.key(),
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
        payer = depositor,
        associated_token::mint = shares_mint,
        associated_token::authority = depositor,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Deposit pre-wrapped wSOL: standard SPL transfer, mint shares.
pub fn deposit_wsol_handler(
    ctx: Context<DepositWsol>,
    amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(amount > 0, SolVaultError::ZeroAmount);
    require!(amount >= MIN_DEPOSIT_AMOUNT, SolVaultError::DepositTooSmall);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    // Read total assets BEFORE deposit
    let total_assets = get_total_assets(vault, &ctx.accounts.wsol_vault);

    // 1. Transfer wSOL from user to vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_wsol_account.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 2. Compute shares (floor rounding - favors vault)
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
            amount,
        )?;

        let shares = convert_to_shares(
            amount,
            total_assets,
            total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?;

        let result =
            module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = convert_to_shares(
        amount,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(net_shares >= min_shares_out, SolVaultError::SlippageExceeded);

    // 3. Mint shares to depositor
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
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

    // 4. Update stored balance if applicable
    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_add(amount)
            .ok_or(SolVaultError::MathOverflow)?;
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

// =============================================================================
// Helpers
// =============================================================================

/// Read total assets based on vault's balance model.
pub fn get_total_assets(vault: &SolVault, wsol_vault: &InterfaceAccount<TokenAccount>) -> u64 {
    match vault.balance_model {
        BalanceModel::Live => wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    }
}

/// Call sync_native on a wSOL token account to update its amount to match lamport balance.
pub fn sync_native_cpi<'info>(
    token_program: &AccountInfo<'info>,
    native_account: &AccountInfo<'info>,
) -> Result<()> {
    let ix = spl_token_2022::instruction::sync_native(
        token_program.key,
        native_account.key,
    )?;

    invoke(&ix, &[native_account.clone()])?;
    Ok(())
}
