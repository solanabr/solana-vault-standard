//! Redeem instructions: burn exact shares for proportional assets (wSOL or native SOL).

use anchor_lang::prelude::*;
use anchor_spl::{
    token::{self, CloseAccount, Mint as SplMint, Token, TokenAccount, Transfer},
    token_2022::{self, Burn, Token2022},
    token_interface::{Mint, TokenAccount as InterfaceTokenAccount},
};

use crate::{
    constants::VAULT_SEED,
    error::VaultError,
    events::Withdraw as WithdrawEvent,
    math::{convert_to_assets, Rounding},
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct RedeemWsol<'info> {
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
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct RedeemSol<'info> {
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
        constraint = wsol_mint.key() == token::spl_token::native_mint::ID @ VaultError::InvalidWsolMint,
    )]
    pub wsol_mint: Account<'info, SplMint>,

    #[account(
        mut,
        constraint = wsol_vault.key() == vault.wsol_vault @ VaultError::InvalidWsolAccount,
        constraint = wsol_vault.mint == token::spl_token::native_mint::ID @ VaultError::InvalidWsolMint,
        constraint = wsol_vault.owner == vault.key() @ VaultError::InvalidWsolAccount,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = user,
        token::mint = wsol_mint,
        token::authority = vault,
    )]
    pub temp_wsol_account: Account<'info, TokenAccount>,

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
    pub user_shares_account: InterfaceAccount<'info, InterfaceTokenAccount>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

fn current_total_assets(vault: &SolVault, wsol_vault: &TokenAccount) -> u64 {
    match vault.balance_model {
        BalanceModel::Live => wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    }
}

pub fn redeem_wsol_handler(
    ctx: Context<RedeemWsol>,
    shares: u64,
    min_assets_out: u64,
) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    let total_assets = current_total_assets(&ctx.accounts.vault, &ctx.accounts.wsol_vault);
    let total_shares = ctx.accounts.shares_mint.supply;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(assets >= min_assets_out, VaultError::SlippageExceeded);
    require!(assets <= total_assets, VaultError::InsufficientAssets);

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

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.wsol_vault.to_account_info(),
                to: ctx.accounts.user_wsol_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets,
    )?;

    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_sub(assets)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(WithdrawEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}

pub fn redeem_sol_handler(ctx: Context<RedeemSol>, shares: u64, min_assets_out: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    let total_assets = current_total_assets(&ctx.accounts.vault, &ctx.accounts.wsol_vault);
    let total_shares = ctx.accounts.shares_mint.supply;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(assets >= min_assets_out, VaultError::SlippageExceeded);
    require!(assets <= total_assets, VaultError::InsufficientAssets);

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

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.wsol_vault.to_account_info(),
                to: ctx.accounts.temp_wsol_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets,
    )?;

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.temp_wsol_account.to_account_info(),
            destination: ctx.accounts.user.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    ))?;

    let vault = &mut ctx.accounts.vault;
    if vault.balance_model == BalanceModel::Stored {
        vault.total_assets = vault
            .total_assets
            .checked_sub(assets)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(WithdrawEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}
