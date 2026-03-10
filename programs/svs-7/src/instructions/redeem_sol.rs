//! Redeem SOL instruction: burn exact shares, receive native SOL.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self as spl_token_cpi},
    token_2022::{self, Burn, Token2022},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::SOL_VAULT_SEED,
    error::VaultError,
    events::Withdraw as WithdrawEvent,
    math::{convert_to_assets, Rounding},
    state::{BalanceModel, SolVault},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct RedeemSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

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
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// Native mint (wSOL)
    #[account(
        constraint = native_mint.key() == anchor_spl::token::spl_token::native_mint::id()
            @ VaultError::InvalidNativeMint,
    )]
    pub native_mint: InterfaceAccount<'info, Mint>,

    /// Temporary wSOL ATA for user — receives wSOL, then closed to unwrap as native SOL
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = native_mint,
        associated_token::authority = user,
        associated_token::token_program = wsol_token_program,
    )]
    pub user_wsol_account: InterfaceAccount<'info, TokenAccount>,

    pub wsol_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Redeem shares for native SOL (floor rounding — user gets less, protects vault).
///
/// Flow:
/// 1. Burn shares from user
/// 2. SPL Token transfer wSOL from vault → user temp wSOL ATA (moves lamports for native mint)
/// 3. Close user's temp wSOL ATA → user receives native SOL
pub fn handler(ctx: Context<RedeemSol>, shares: u64, min_lamports_out: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    let total_assets = match vault.balance_model {
        BalanceModel::Live => ctx.accounts.wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    };

    // Calculate lamports to receive (floor rounding)
    let lamports = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

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

        let result =
            module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, lamports)?;
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let net_lamports = lamports;

    // Slippage check
    require!(
        net_lamports >= min_lamports_out,
        VaultError::SlippageExceeded
    );
    require!(lamports <= total_assets, VaultError::InsufficientAssets);

    // 1. Burn shares
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

    // 2. Transfer wSOL from vault → user's temp wSOL ATA
    //    SPL Token program moves BOTH amount AND lamports for native mint accounts
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        SOL_VAULT_SEED,
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    spl_token_cpi::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.wsol_token_program.to_account_info(),
            spl_token_cpi::Transfer {
                from: ctx.accounts.wsol_vault.to_account_info(),
                to: ctx.accounts.user_wsol_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_lamports,
    )?;

    // 3. Close user's temp wSOL ATA → unwraps to native SOL (lamports → user)
    spl_token_cpi::close_account(
        CpiContext::new(
            ctx.accounts.wsol_token_program.to_account_info(),
            spl_token_cpi::CloseAccount {
                account: ctx.accounts.user_wsol_account.to_account_info(),
                destination: ctx.accounts.user.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
    )?;

    // 4. Update stored balance
    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_sub(lamports)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(WithdrawEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets: net_lamports,
        shares,
        is_native: true,
    });

    Ok(())
}
