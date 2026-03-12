use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{mint_to, Mint, MintTo, TokenAccount},
};

use crate::constants::{INVESTMENT_REQUEST_SEED, SHARES_MINT_SEED, VAULT_SEED};
use crate::error::VaultError;
use crate::events::InvestmentClaimed;
use crate::state::{CreditVault, InvestmentRequest, RequestStatus};

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
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
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump = investment_request.bump,
        constraint = investment_request.status == RequestStatus::Approved @ VaultError::RequestNotApproved,
        constraint = investor.key() == investment_request.investor,
    )]
    pub investment_request: Account<'info, InvestmentRequest>,

    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = shares_mint,
        associated_token::authority = investor,
        associated_token::token_program = token_2022_program,
    )]
    pub investor_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<ClaimDeposit>) -> Result<()> {
    let shares = ctx.accounts.investment_request.shares_claimable;

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.investor_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        shares,
    )?;

    emit!(InvestmentClaimed {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.investor.key(),
        shares,
    });

    Ok(())
}
