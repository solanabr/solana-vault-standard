use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{error::VaultError, events::Repayment, state::CreditVault};

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        mut,
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = manager_asset_account.mint == vault.asset_mint,
        constraint = manager_asset_account.owner == manager.key(),
    )]
    pub manager_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = deposit_vault.key() == vault.deposit_vault,
    )]
    pub deposit_vault: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Repay>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);

    // Delta-based accounting for T22 transfer fees
    let before = ctx.accounts.deposit_vault.amount;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.manager_asset_account.to_account_info(),
                to: ctx.accounts.deposit_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.manager.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    ctx.accounts.deposit_vault.reload()?;
    let actual = ctx
        .accounts
        .deposit_vault
        .amount
        .checked_sub(before)
        .ok_or(VaultError::MathOverflow)?;

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_add(actual)
        .ok_or(VaultError::MathOverflow)?;

    emit!(Repayment {
        vault: vault.key(),
        amount: actual,
        new_total_assets: vault.total_assets,
    });

    Ok(())
}
