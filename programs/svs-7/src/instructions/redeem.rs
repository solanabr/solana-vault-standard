//! redeem_sol: burn exact shares → native SOL to user
//! redeem_wsol: burn exact shares → wSOL to user

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use svs_math::{convert_to_assets, Rounding};

use crate::{
    constants::{SHARES_MINT_SEED, SOL_VAULT_SEED},
    error::VaultError,
    events::{RedeemSolEvent, RedeemWsolEvent},
    state::{BalanceModel, SolVault},
};

// ─── redeem_sol ───────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RedeemSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::InvalidAccount,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = wsol_vault.key() == vault.wsol_vault @ VaultError::InvalidAccount,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub spl_token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn redeem_sol(ctx: Context<RedeemSol>, shares: u64, min_lamports_out: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let total_assets = match vault.balance_model {
        BalanceModel::Live => ctx.accounts.wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    };
    let total_shares = ctx.accounts.shares_mint.supply;

    // Floor — user gets fewer lamports (vault-favoring)
    let lamports = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    ).map_err(|_| error!(crate::error::VaultError::MathOverflow))?;
    require!(lamports >= min_lamports_out, VaultError::SlippageExceeded);
    require!(lamports <= ctx.accounts.wsol_vault.amount, VaultError::InsufficientAssets);

    // Burn shares
    anchor_spl::token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            anchor_spl::token_2022::Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // Transfer native SOL from vault PDA to user
    let vault_info = ctx.accounts.vault.to_account_info();
    let user_info = ctx.accounts.user.to_account_info();
    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(lamports)
        .ok_or(VaultError::InsufficientAssets)?;
    **user_info.try_borrow_mut_lamports()? = user_info
        .lamports()
        .checked_add(lamports)
        .ok_or(VaultError::MathOverflow)?;

    if ctx.accounts.vault.balance_model == BalanceModel::Stored {
        let vault = &mut ctx.accounts.vault;
        vault.total_assets = vault.total_assets
            .checked_sub(lamports)
            .ok_or(VaultError::InsufficientAssets)?;
    }

    emit!(RedeemSolEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        lamports,
        shares,
    });

    Ok(())
}

// ─── redeem_wsol ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RedeemWsol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    pub native_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::InvalidAccount,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = wsol_vault.key() == vault.wsol_vault @ VaultError::InvalidAccount,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = native_mint,
        associated_token::authority = user,
        associated_token::token_program = spl_token_program,
    )]
    pub user_wsol_account: InterfaceAccount<'info, TokenAccount>,

    pub spl_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn redeem_wsol(ctx: Context<RedeemWsol>, shares: u64, min_lamports_out: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let total_assets = match vault.balance_model {
        BalanceModel::Live => ctx.accounts.wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    };
    let total_shares = ctx.accounts.shares_mint.supply;

    let lamports = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    ).map_err(|_| error!(crate::error::VaultError::MathOverflow))?;
    require!(lamports >= min_lamports_out, VaultError::SlippageExceeded);
    require!(lamports <= ctx.accounts.wsol_vault.amount, VaultError::InsufficientAssets);

    // Burn shares
    anchor_spl::token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            anchor_spl::token_2022::Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // Transfer wSOL to user
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[SOL_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    anchor_spl::token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.spl_token_program.to_account_info(),
            anchor_spl::token_interface::TransferChecked {
                from: ctx.accounts.wsol_vault.to_account_info(),
                to: ctx.accounts.user_wsol_account.to_account_info(),
                mint: ctx.accounts.native_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        lamports,
        9,
    )?;

    if ctx.accounts.vault.balance_model == BalanceModel::Stored {
        let vault = &mut ctx.accounts.vault;
        vault.total_assets = vault.total_assets
            .checked_sub(lamports)
            .ok_or(VaultError::InsufficientAssets)?;
    }

    emit!(RedeemWsolEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        lamports,
        shares,
    });

    Ok(())
}
