//! Withdraw instruction: burn shares to receive exact native SOL assets.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::VAULT_SEED,
    error::VaultError,
    events::Withdraw as WithdrawEvent,
    math::{checkpoint_stream, convert_to_shares, effective_total_assets, Rounding},
    state::NativeSolStreamVault,
};

#[derive(Accounts)]
pub struct Withdraw<'info> {
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
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<Withdraw>, assets: u64, max_shares_in: u64) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    let vault = &ctx.accounts.vault;
    let total_assets = effective_total_assets(vault, now)?;
    let total_shares = ctx.accounts.shares_mint.supply;

    require!(assets <= total_assets, VaultError::InsufficientAssets);

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    require!(shares <= max_shares_in, VaultError::SlippageExceeded);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

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

    let vault = &mut ctx.accounts.vault;
    let (_, effective_after_checkpoint) = checkpoint_stream(vault, now)?;
    vault.base_assets = effective_after_checkpoint
        .checked_sub(assets)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = total_shares
        .checked_sub(shares)
        .ok_or(VaultError::MathOverflow)?;

    let rent_minimum = Rent::get()?.minimum_balance(NativeSolStreamVault::LEN);
    let remaining_lamports = ctx
        .accounts
        .vault
        .to_account_info()
        .lamports()
        .checked_sub(assets)
        .ok_or(VaultError::InsufficientLamports)?;
    require!(remaining_lamports >= rent_minimum, VaultError::InsufficientLamports);

    {
        let vault_info = ctx.accounts.vault.to_account_info();
        let mut vault_lamports = vault_info.try_borrow_mut_lamports()?;
        let next = (**vault_lamports)
            .checked_sub(assets)
            .ok_or(VaultError::InsufficientLamports)?;
        **vault_lamports = next;
    }
    {
        let user_info = ctx.accounts.user.to_account_info();
        let mut user_lamports = user_info.try_borrow_mut_lamports()?;
        let next = (**user_lamports)
            .checked_add(assets)
            .ok_or(VaultError::MathOverflow)?;
        **user_lamports = next;
    }

    emit!(WithdrawEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}
