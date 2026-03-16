use anchor_lang::prelude::*;
use anchor_spl::{token_2022::{self, Burn, Token2022}, token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked}};
use crate::{constants::ALLOCATOR_SEED, error::AllocatorError, events::Redeem as RedeemEvent, math::{convert_to_assets, Rounding}, state::AllocatorVault};

pub fn handler(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()> {
    require!(shares > 0, AllocatorError::ZeroAmount);
    require!(!ctx.accounts.allocator_vault.paused, AllocatorError::VaultPaused);
    require!(ctx.accounts.user_shares_account.amount >= shares, AllocatorError::InsufficientShares);
    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let idle_balance = ctx.accounts.idle_vault.amount;
    let assets = convert_to_assets(shares, idle_balance, total_shares, vault.decimals_offset, Rounding::Floor)?;
    require!(assets >= min_assets_out, AllocatorError::SlippageExceeded);
    require!(idle_balance >= assets, AllocatorError::InsufficientLiquidity);
    token_2022::burn(CpiContext::new(ctx.accounts.token_2022_program.to_account_info(), Burn { mint: ctx.accounts.shares_mint.to_account_info(), from: ctx.accounts.user_shares_account.to_account_info(), authority: ctx.accounts.user.to_account_info() }), shares)?;
    let vault_asset_mint = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[ALLOCATOR_SEED, vault_asset_mint.as_ref(), vault_id_bytes.as_ref(), &[bump]]];
    transfer_checked(CpiContext::new_with_signer(ctx.accounts.asset_token_program.to_account_info(), TransferChecked { from: ctx.accounts.idle_vault.to_account_info(), to: ctx.accounts.user_asset_account.to_account_info(), mint: ctx.accounts.asset_mint.to_account_info(), authority: ctx.accounts.allocator_vault.to_account_info() }, signer_seeds), assets, ctx.accounts.asset_mint.decimals)?;
    emit!(RedeemEvent { vault: ctx.accounts.allocator_vault.key(), caller: ctx.accounts.user.key(), owner: ctx.accounts.user.key(), shares, assets });
    Ok(())
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)] pub user: Signer<'info>,
    #[account(constraint = !allocator_vault.paused @ AllocatorError::VaultPaused)] pub allocator_vault: Account<'info, AllocatorVault>,
    #[account(constraint = asset_mint.key() == allocator_vault.asset_mint)] pub asset_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, constraint = user_asset_account.mint == allocator_vault.asset_mint, constraint = user_asset_account.owner == user.key())] pub user_asset_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, constraint = idle_vault.key() == allocator_vault.idle_vault)] pub idle_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, constraint = shares_mint.key() == allocator_vault.shares_mint)] pub shares_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, constraint = user_shares_account.mint == allocator_vault.shares_mint, constraint = user_shares_account.owner == user.key())] pub user_shares_account: InterfaceAccount<'info, TokenAccount>,
    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
