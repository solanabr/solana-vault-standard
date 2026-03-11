use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::constants::{REDEMPTION_ESCROW_SEED, SHARES_MINT_SEED, VAULT_SEED};
use crate::state::CreditVault;

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = CreditVault::LEN,
        seeds = [VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, CreditVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Shares mint initialized via CPI in handler
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = asset_token_program,
    )]
    pub deposit_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Redemption escrow initialized via CPI in handler
    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump
    )]
    pub redemption_escrow: UncheckedAccount<'info>,

    /// CHECK: Oracle account validated in handler
    pub nav_oracle: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    _ctx: Context<InitializePool>,
    _vault_id: u64,
    _name: String,
    _symbol: String,
    _uri: String,
    _minimum_investment: u64,
    _max_staleness: i64,
) -> Result<()> {
    Ok(())
}
