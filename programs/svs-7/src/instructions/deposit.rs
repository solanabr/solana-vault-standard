//! Deposit instructions for native SOL and wrapped SOL.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, SyncNative, Token, TokenAccount, Transfer},
    token_2022::{self, MintTo, Token2022},
    token_interface::{Mint, TokenAccount as InterfaceTokenAccount},
};

use crate::{
    constants::{MIN_DEPOSIT_AMOUNT, VAULT_SEED},
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_shares, Rounding},
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, SolVault>,

    #[account(
        mut,
        constraint = wsol_vault.key() == vault.wsol_vault @ VaultError::InvalidWsolAccount,
        constraint = wsol_vault.mint == token::spl_token::native_mint::ID @ VaultError::InvalidWsolMint,
        constraint = wsol_vault.owner == vault.key() @ VaultError::InvalidWsolAccount,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

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
    pub user_shares_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositWsol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, SolVault>,

    #[account(
        mut,
        constraint = user_wsol_account.owner == user.key() @ VaultError::InvalidWsolAccount,
        constraint = user_wsol_account.mint == token::spl_token::native_mint::ID @ VaultError::InvalidWsolMint,
    )]
    pub user_wsol_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = wsol_vault.key() == vault.wsol_vault @ VaultError::InvalidWsolAccount,
        constraint = wsol_vault.mint == token::spl_token::native_mint::ID @ VaultError::InvalidWsolMint,
        constraint = wsol_vault.owner == vault.key() @ VaultError::InvalidWsolAccount,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

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
    pub user_shares_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

fn current_total_assets(vault: &SolVault, wsol_vault: &TokenAccount) -> u64 {
    match vault.balance_model {
        BalanceModel::Live => wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    }
}

pub fn deposit_sol_handler(
    ctx: Context<DepositSol>,
    assets: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    let total_assets = current_total_assets(&ctx.accounts.vault, &ctx.accounts.wsol_vault);
    let total_shares = ctx.accounts.shares_mint.supply;

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
            },
        ),
        assets,
    )?;

    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SyncNative {
            account: ctx.accounts.wsol_vault.to_account_info(),
        },
    ))?;

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

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
        shares,
    )?;

    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_add(assets)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(DepositEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}

pub fn deposit_wsol_handler(
    ctx: Context<DepositWsol>,
    assets: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    let total_assets = current_total_assets(&ctx.accounts.vault, &ctx.accounts.wsol_vault);
    let total_shares = ctx.accounts.shares_mint.supply;

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_wsol_account.to_account_info(),
                to: ctx.accounts.wsol_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        assets,
    )?;

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

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
        shares,
    )?;

    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_add(assets)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(DepositEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}
