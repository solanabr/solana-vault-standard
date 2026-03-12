use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};
use crate::{
    error::VaultError,
    events::AssetRemoved,
    state::{AssetEntry, MultiAssetVault},
};

pub fn handler(ctx: Context<RemoveAsset>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let asset_entry = &ctx.accounts.asset_entry;

    require!(ctx.accounts.asset_vault.amount == 0, VaultError::AssetVaultNotEmpty);

    let index = asset_entry.index;

    vault.num_assets = vault.num_assets
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    emit!(AssetRemoved {
        vault: vault.key(),
        asset_mint: asset_entry.asset_mint,
        index,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveAsset<'info> {
    #[account(mut, has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,

    pub authority: Signer<'info>,

    #[account(
        mut,
        close = authority,
        has_one = vault,
    )]
    pub asset_entry: Account<'info, AssetEntry>,

    #[account(
        mut,
        constraint = asset_vault.amount == 0 @ VaultError::AssetVaultNotEmpty,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
