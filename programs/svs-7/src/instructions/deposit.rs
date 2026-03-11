//! deposit_sol: native SOL → wSOL → mint shares
//! deposit_wsol: existing wSOL → mint shares

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use svs_math::{convert_to_shares, Rounding};

use crate::{
    constants::{MIN_DEPOSIT_LAMPORTS, SHARES_MINT_SEED, SOL_VAULT_SEED},
    error::VaultError,
    events::{DepositSolEvent, DepositWsolEvent},
    state::{BalanceModel, SolVault},
};

// ─── deposit_sol ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// CHECK: native SOL mint
    pub native_mint: UncheckedAccount<'info>,

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
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub spl_token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_sol(ctx: Context<DepositSol>, lamports: u64, min_shares_out: u64) -> Result<()> {
    require!(lamports >= MIN_DEPOSIT_LAMPORTS, VaultError::DepositTooSmall);

    // 1. Transfer native SOL from user to wsol_vault token account
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
            },
        ),
        lamports,
    )?;

    // 2. sync_native to update token account's amount field
    let sync_ix = spl_token_2022::instruction::sync_native(
        &ctx.accounts.spl_token_program.key(),
        &ctx.accounts.wsol_vault.key(),
    )?;
    anchor_lang::solana_program::program::invoke(
        &sync_ix,
        &[ctx.accounts.wsol_vault.to_account_info()],
    )?;

    // 3. Reload wsol_vault to get updated amount
    ctx.accounts.wsol_vault.reload()?;

    // 4. Compute total_assets
    let vault = &ctx.accounts.vault;
    let total_assets = match vault.balance_model {
        BalanceModel::Live => ctx.accounts.wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    };
    let total_shares = ctx.accounts.shares_mint.supply;

    // 5. Compute shares (floor — favors vault)
    let shares = convert_to_shares(
        lamports,
        total_assets.saturating_sub(lamports), // pre-deposit total
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    ).map_err(|_| error!(crate::error::VaultError::MathOverflow))?;

    require!(shares >= min_shares_out, VaultError::SlippageExceeded);
    require!(shares > 0, VaultError::ZeroAmount);

    // 6. Mint shares to user (vault PDA signs)
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[SOL_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    anchor_spl::token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            anchor_spl::token_2022::MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    // 7. Update stored balance
    if ctx.accounts.vault.balance_model == BalanceModel::Stored {
        let vault = &mut ctx.accounts.vault;
        vault.total_assets = vault.total_assets
            .checked_add(lamports)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(DepositSolEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        lamports,
        shares,
    });

    Ok(())
}

// ─── deposit_wsol ────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct DepositWsol<'info> {
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
        constraint = user_wsol_account.mint == native_mint.key(),
        constraint = user_wsol_account.owner == user.key(),
    )]
    pub user_wsol_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub spl_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_wsol(ctx: Context<DepositWsol>, lamports: u64, min_shares_out: u64) -> Result<()> {
    require!(lamports >= MIN_DEPOSIT_LAMPORTS, VaultError::DepositTooSmall);

    let vault = &ctx.accounts.vault;
    let total_assets = match vault.balance_model {
        BalanceModel::Live => ctx.accounts.wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    };
    let total_shares = ctx.accounts.shares_mint.supply;

    let shares = convert_to_shares(
        lamports,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    ).map_err(|_| error!(crate::error::VaultError::MathOverflow))?;
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);
    require!(shares > 0, VaultError::ZeroAmount);

    // Transfer wSOL from user to wsol_vault
    anchor_spl::token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.spl_token_program.to_account_info(),
            anchor_spl::token_interface::TransferChecked {
                from: ctx.accounts.user_wsol_account.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
                mint: ctx.accounts.native_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        lamports,
        9, // SOL decimals
    )?;

    // Mint shares
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[SOL_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    anchor_spl::token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            anchor_spl::token_2022::MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    if ctx.accounts.vault.balance_model == BalanceModel::Stored {
        let vault = &mut ctx.accounts.vault;
        vault.total_assets = vault.total_assets
            .checked_add(lamports)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(DepositWsolEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        lamports,
        shares,
    });

    Ok(())
}
