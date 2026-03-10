//! Initialize instruction: create the vault state, shares mint, and wSOL vault account.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{VAULT_SEED, WSOL_MINT}, // Precisaremos adicionar WSOL_MINT no constants.rs
    state::Vault,
};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = Vault::LEN,
        seeds = [
            VAULT_SEED,
            WSOL_MINT.as_ref(), // Travado em wSOL
            vault_id.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = payer,
        mint::decimals = 9, // SOL sempre tem 9 decimais
        mint::authority = vault,
        extensions::metadata_pointer::authority = vault,
        extensions::metadata_pointer::metadata_address = shares_mint,
        token::token_program = token_2022_program,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(address = WSOL_MINT)]
    pub wsol_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>, 
    vault_id: u64, 
    _name: String, 
    _symbol: String, 
    _uri: String
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    
    vault.authority = ctx.accounts.payer.key();
    vault.asset_mint = ctx.accounts.wsol_mint.key();
    vault.asset_vault = ctx.accounts.wsol_vault.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.total_assets = 0;
    vault.vault_id = vault_id;
    vault.bump = ctx.bumps.vault;
    vault.decimals_offset = 0; // SOL 9 decimals, virtual offset minimal
    vault.paused = false;

    Ok(())
}