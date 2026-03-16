use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token_2022::{self, MintTo, Token2022}, token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked}};
use crate::{constants::{ALLOCATOR_SEED, MIN_DEPOSIT_AMOUNT}, error::AllocatorError, events::Deposit as DepositEvent, math::{convert_to_shares, Rounding}, state::AllocatorVault};

pub fn handler(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
    require!(assets >= MIN_DEPOSIT_AMOUNT, AllocatorError::DepositTooSmall);
    require!(!ctx.accounts.allocator_vault.paused, AllocatorError::VaultPaused);
    let vault = &ctx.accounts.allocator_vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = ctx.accounts.idle_vault.amount;
    let shares = convert_to_shares(assets, total_assets, total_shares, vault.decimals_offset, Rounding::Floor)?;
    require!(shares >= min_shares_out, AllocatorError::SlippageExceeded);
    transfer_checked(CpiContext::new(ctx.accounts.asset_token_program.to_account_info(), TransferChecked { from: ctx.accounts.user_asset_account.to_account_info(), to: ctx.accounts.idle_vault.to_account_info(), mint: ctx.accounts.asset_mint.to_account_info(), authority: ctx.accounts.user.to_account_info() }), assets, ctx.accounts.asset_mint.decimals)?;
    let vault_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[ALLOCATOR_SEED, vault_key.as_ref(), vault_id_bytes.as_ref(), &[bump]]];
    token_2022::mint_to(CpiContext::new_with_signer(ctx.accounts.token_2022_program.to_account_info(), MintTo { mint: ctx.accounts.shares_mint.to_account_info(), to: ctx.accounts.user_shares_account.to_account_info(), authority: ctx.accounts.allocator_vault.to_account_info() }, signer_seeds), shares)?;
    emit!(DepositEvent { vault: ctx.accounts.allocator_vault.key(), caller: ctx.accounts.user.key(), owner: ctx.accounts.user.key(), assets, shares });
    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)] pub user: Signer<'info>,
    #[account(constraint = !allocator_vault.paused @ AllocatorError::VaultPaused)] pub allocator_vault: Account<'info, AllocatorVault>,
    #[account(constraint = asset_mint.key() == allocator_vault.asset_mint)] pub asset_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, constraint = user_asset_account.mint == allocator_vault.asset_mint, constraint = user_asset_account.owner == user.key())] pub user_asset_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, constraint = idle_vault.key() == allocator_vault.idle_vault)] pub idle_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, constraint = shares_mint.key() == allocator_vault.shares_mint)] pub shares_mint: InterfaceAccount<'info, Mint>,
    #[account(init_if_needed, payer = user, associated_token::mint = shares_mint, associated_token::authority = user, associated_token::token_program = token_2022_program)] pub user_shares_account: InterfaceAccount<'info, TokenAccount>,
    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
