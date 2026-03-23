use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::{ASSET_ENTRY_SEED, VAULT_SEED},
    error::VaultError,
    events::AssetRemoved,
    state::{AssetEntry, MultiAssetVault},
};

#[derive(Accounts)]
pub struct RemoveAsset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.authority == authority.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(
        mut,
        close = authority,
        seeds = [ASSET_ENTRY_SEED, vault.key().as_ref(), asset_entry.asset_mint.as_ref()],
        bump = asset_entry.bump,
        constraint = asset_entry.vault == vault.key() @ VaultError::AssetNotFound,
    )]
    pub asset_entry: Account<'info, AssetEntry>,

    #[account(
        constraint = asset_vault.key() == asset_entry.asset_vault @ VaultError::InvalidAssetVault,
        constraint = asset_vault.amount == 0 @ VaultError::AssetVaultNotEmpty,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RemoveAsset>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let removed_index = ctx.accounts.asset_entry.index;
    let removed_mint = ctx.accounts.asset_entry.asset_mint;

    vault.num_assets = vault
        .num_assets
        .checked_sub(1)
        .ok_or(error!(VaultError::MathOverflow))?;

    emit!(AssetRemoved {
        vault: vault.key(),
        asset_mint: removed_mint,
        index: removed_index,
    });

    Ok(())
}
