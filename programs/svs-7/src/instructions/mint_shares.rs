//! mint_sol: user pays native SOL to receive exact shares

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};
use svs_math::{convert_to_assets, Rounding};

use crate::{
    constants::{SHARES_MINT_SEED, SOL_VAULT_SEED},
    error::VaultError,
    events::MintSharesEvent,
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
pub struct MintShares<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, SolVault>,

    /// CHECK: native mint
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

pub fn mint_shares(ctx: Context<MintShares>, shares: u64, max_lamports_in: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let total_assets = match vault.balance_model {
        BalanceModel::Live => ctx.accounts.wsol_vault.amount,
        BalanceModel::Stored => vault.total_assets,
    };
    let total_shares = ctx.accounts.shares_mint.supply;

    // Ceiling — user pays more lamports (vault-favoring)
    let lamports = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    ).map_err(|_| error!(crate::error::VaultError::MathOverflow))?;
    require!(lamports <= max_lamports_in, VaultError::SlippageExceeded);

    // Transfer SOL to wsol_vault
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

    // sync_native
    let sync_ix = spl_token_2022::instruction::sync_native(
        &ctx.accounts.spl_token_program.key(),
        &ctx.accounts.wsol_vault.key(),
    )?;
    anchor_lang::solana_program::program::invoke(
        &sync_ix,
        &[ctx.accounts.wsol_vault.to_account_info()],
    )?;

    // Mint exact shares to user
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

    emit!(MintSharesEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        lamports,
        shares,
    });

    Ok(())
}
