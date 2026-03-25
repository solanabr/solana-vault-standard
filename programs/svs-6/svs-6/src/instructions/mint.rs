use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use spl_token_2022::extension::confidential_transfer::instruction::deposit as confidential_deposit;

use crate::constants::*;
use crate::error::VaultError;
use crate::events::DepositEvent;
use crate::math::{convert_to_assets, Rounding};
use crate::state::ConfidentialStreamVault;

#[derive(Accounts)]
pub struct MintShares<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, ConfidentialStreamVault>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = asset_vault.key() == vault.asset_vault)]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    /// The user's shares account (must already be configured for confidential transfers)
    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MintShares>, shares: u64, max_assets_in: u64) -> Result<()> {
    // 1. VALIDATION
    require!(shares > 0, VaultError::ZeroAmount);

    // 2. READ STATE
    let vault = &ctx.accounts.vault;
    let clock = Clock::get()?;
    let total_assets = vault.effective_total_assets(clock.unix_timestamp)?;
    let total_shares = vault.total_shares;

    // 3. COMPUTE — assets = shares × (A + 1) / (S + offset), Ceiling
    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling, // User pays more (vault-favoring)
    )?;

    // 4. SLIPPAGE CHECK
    require!(assets <= max_assets_in, VaultError::SlippageExceeded);
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    // 5. EXECUTE CPIs
    // 5a. Transfer assets: user → vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_asset_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 5b. Mint shares: → user (vault PDA signs)
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
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
        shares,
    )?;

    // 5c. Move shares from non-confidential to confidential PENDING balance
    let deposit_ix = confidential_deposit(
        &ctx.accounts.token_2022_program.key(),
        &ctx.accounts.user_shares_account.key(),
        &ctx.accounts.shares_mint.key(),
        shares,
        SHARES_DECIMALS,
        &ctx.accounts.user.key(),
        &[],
    )?;

    invoke(
        &deposit_ix,
        &[
            ctx.accounts.user_shares_account.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
            ctx.accounts.user.to_account_info(),
        ],
    )?;

    // 6. UPDATE STATE
    let vault = &mut ctx.accounts.vault;
    vault.base_assets = vault
        .base_assets
        .checked_add(assets)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT
    emit!(DepositEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}
