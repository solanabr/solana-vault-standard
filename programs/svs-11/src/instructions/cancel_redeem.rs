use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::constants::{
    REDEMPTION_ESCROW_SEED, REDEMPTION_REQUEST_SEED, SHARES_DECIMALS, VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionCancelled;
use crate::state::{CreditVault, RedemptionRequest, RequestStatus};

#[derive(Accounts)]
pub struct CancelRedeem<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        close = investor,
        has_one = vault,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump = redemption_request.bump,
        constraint = redemption_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
        constraint = investor.key() == redemption_request.investor,
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = investor_shares_account.mint == vault.shares_mint,
        constraint = investor_shares_account.owner == investor.key(),
    )]
    pub investor_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump = vault.redemption_escrow_bump,
    )]
    pub redemption_escrow: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelRedeem>) -> Result<()> {
    let shares_to_return = ctx.accounts.redemption_request.shares_locked;

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.redemption_escrow.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.investor_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        shares_to_return,
        SHARES_DECIMALS,
    )?;

    emit!(RedemptionCancelled {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.investor.key(),
        shares: shares_to_return,
    });

    Ok(())
}
