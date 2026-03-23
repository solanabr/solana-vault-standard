use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{ASSET_ENTRY_SEED, VAULT_SEED},
    error::VaultError,
    events::SingleRedeem,
    math::{mul_div, Rounding},
    state::{AssetEntry, MultiAssetVault},
};

#[derive(Accounts)]
pub struct RedeemSingle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, MultiAssetVault>,

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

    // The asset being redeemed into
    pub redeem_asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [ASSET_ENTRY_SEED, vault.key().as_ref(), redeem_asset_mint.key().as_ref()],
        bump = redeem_asset_entry.bump,
        constraint = redeem_asset_entry.vault == vault.key() @ VaultError::AssetNotFound,
    )]
    pub redeem_asset_entry: Account<'info, AssetEntry>,

    #[account(
        mut,
        constraint = redeem_asset_vault.key() == redeem_asset_entry.asset_vault @ VaultError::InvalidAssetVault,
    )]
    pub redeem_asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_redeem_account.mint == redeem_asset_mint.key(),
        constraint = user_redeem_account.owner == user.key(),
    )]
    pub user_redeem_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Redeem shares for a single asset proportionally.
/// amount_out = shares / total_shares * asset_vault.amount (floor)
/// No oracle needed — direct balance proportion.
pub fn handler(ctx: Context<RedeemSingle>, shares: u64, min_amount_out: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    let total_shares = ctx.accounts.shares_mint.supply;
    let asset_balance = ctx.accounts.redeem_asset_vault.amount;

    // Proportional: amount_out = shares * asset_balance / total_shares
    let amount_out = mul_div(shares, asset_balance, total_shares, Rounding::Floor)?;

    require!(amount_out >= min_amount_out, VaultError::SlippageExceeded);
    require!(amount_out <= asset_balance, VaultError::InsufficientAssets);

    // Burn shares
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

    // Transfer assets to user
    let vault = &ctx.accounts.vault;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.redeem_asset_vault.to_account_info(),
                to: ctx.accounts.user_redeem_account.to_account_info(),
                mint: ctx.accounts.redeem_asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        amount_out,
        ctx.accounts.redeem_asset_mint.decimals,
    )?;

    emit!(SingleRedeem {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        asset_mint: ctx.accounts.redeem_asset_mint.key(),
        shares,
        amount_out,
    });

    Ok(())
}
