use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, Token2022},
};
use crate::{
    constants::{MULTI_VAULT_SEED, SHARES_SEED},
    error::VaultError,
    events::VaultInitialized,
    state::MultiAssetVault,
};

pub fn handler(
    ctx: Context<Initialize>,
    vault_id: u64,
    base_decimals: u8,
) -> Result<()> {
    // base_decimals must be <= 9 (same rule as asset decimals)
    require!(base_decimals <= 9, VaultError::InvalidAssetDecimals);

    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.decimals_offset = 9u8.saturating_sub(base_decimals);
    vault.bump = ctx.bumps.vault;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault.num_assets = 0;
    vault.base_decimals = base_decimals;
    vault._reserved = [0u8; 64];

    emit!(VaultInitialized {
        vault: vault.key(),
        authority: ctx.accounts.authority.key(),
        shares_mint: ctx.accounts.shares_mint.key(),
        vault_id,
        base_decimals,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = MultiAssetVault::LEN,
        seeds = [MULTI_VAULT_SEED, vault_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(
        init,
        payer = authority,
        seeds = [SHARES_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = 9,
        mint::authority = vault,
        mint::freeze_authority = vault,
        mint::token_program = token_program,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
