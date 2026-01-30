use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use spl_token_2022::extension::confidential_transfer::instruction::deposit as confidential_deposit;

use crate::{
    constants::{MIN_DEPOSIT_AMOUNT, SHARES_DECIMALS, VAULT_SEED},
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_shares, Rounding},
    state::ConfidentialVault,
};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
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

/// Deposit assets and receive confidential shares
///
/// The shares are minted to the user's non-confidential balance, then
/// immediately deposited into the confidential pending balance.
/// User must call apply_pending after this to use the shares.
///
/// NOTE: User's shares account must be configured for confidential transfers
/// (call configure_account first)
pub fn handler(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    // Calculate shares to mint (floor rounding - favors vault)
    let shares = convert_to_shares(
        assets,
        vault.total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // Slippage check
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

    // Transfer assets from user to vault
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

    // Mint shares to user's non-confidential balance (vault PDA is mint authority)
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

    // Move minted shares from non-confidential to confidential pending balance
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

    // Update cached total assets
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_add(assets)
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
