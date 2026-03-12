use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{MAX_DECIMALS, TRANCHED_VAULT_SEED},
    error::TranchedVaultError,
    events::VaultInitialized,
    state::{TranchedVault, WaterfallMode},
};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = TranchedVault::LEN,
        seeds = [TRANCHED_VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, TranchedVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = asset_token_program,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, vault_id: u64, waterfall_mode: u8) -> Result<()> {
    let asset_decimals = ctx.accounts.asset_mint.decimals;
    require!(
        asset_decimals <= MAX_DECIMALS,
        TranchedVaultError::InvalidAssetDecimals
    );

    let mode = match waterfall_mode {
        0 => WaterfallMode::Sequential,
        1 => WaterfallMode::ProRataYieldSequentialLoss,
        _ => return err!(TranchedVaultError::InvalidWaterfallMode),
    };

    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.manager = ctx.accounts.authority.key();
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.asset_vault = ctx.accounts.asset_vault.key();
    vault.total_assets = 0;
    vault.num_tranches = 0;
    vault.decimals_offset = MAX_DECIMALS - asset_decimals;
    vault.bump = ctx.bumps.vault;
    vault.paused = false;
    vault.wiped = false;
    vault.priority_bitmap = 0;
    vault.vault_id = vault_id;
    vault.waterfall_mode = mode;
    vault.nav_oracle = None;
    vault.oracle_program = None;
    vault._reserved = [0u8; 63];

    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        asset_mint: vault.asset_mint,
        waterfall_mode,
        vault_id,
    });

    Ok(())
}
