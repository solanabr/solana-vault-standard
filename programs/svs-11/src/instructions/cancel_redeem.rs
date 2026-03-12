use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::VaultError,
    state::{CreditVault, RedemptionRequest, RedemptionStatus},
};

#[derive(Accounts)]
pub struct CancelRedeem<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        constraint = redemption_request.investor == investor.key() @ VaultError::Unauthorized,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump = redemption_request.bump,
        close = investor,
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = redemption_escrow.key() == vault.redemption_escrow,
    )]
    pub redemption_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = investor_shares_account.mint == vault.shares_mint,
        constraint = investor_shares_account.owner == investor.key(),
    )]
    pub investor_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<CancelRedeem>) -> Result<()> {
    let request = &ctx.accounts.redemption_request;

    require!(
        request.status == RedemptionStatus::Pending,
        VaultError::RequestNotPending
    );

    // SVS-11: No cancel delay — instant cancel while Pending
    let shares_to_return = request.shares_locked;

    let vault = &ctx.accounts.vault;
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        CREDIT_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ]];

    // Return shares from escrow to investor
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.redemption_escrow.to_account_info(),
                to: ctx.accounts.investor_shares_account.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares_to_return,
        SHARES_DECIMALS,
    )?;

    Ok(())
}
