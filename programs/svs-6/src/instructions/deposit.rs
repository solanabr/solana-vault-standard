//! Deposit instruction: transfer native SOL to vault, mint shares to user.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::{MIN_DEPOSIT_AMOUNT, VAULT_SEED},
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{checkpoint_stream, convert_to_shares, effective_total_assets, Rounding},
    state::NativeSolStreamVault,
};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, NativeSolStreamVault>,

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

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    let now = Clock::get()?.unix_timestamp;
    let vault = &ctx.accounts.vault;
    let total_assets = effective_total_assets(vault, now)?;
    let total_shares = ctx.accounts.shares_mint.supply;

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
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
    let (_, effective_after_checkpoint) = checkpoint_stream(vault, now)?;
    vault.base_assets = effective_after_checkpoint
        .checked_add(assets)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = total_shares
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;

    emit!(DepositEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}
