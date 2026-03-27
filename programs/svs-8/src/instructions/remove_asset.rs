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

    let removed_index = asset_entry.index;

    // FIX P2-3: completeness check — all other AssetEntry PDAs must be provided
    let expected_others = vault.num_assets as usize - 1;
    require!(
        ctx.remaining_accounts.len() == expected_others,
        VaultError::AssetNotFound
    );

    // re-index remaining AssetEntry accounts to close index gaps
    let svs8_id = crate::ID;
    for info in ctx.remaining_accounts.iter() {
        require!(info.owner == &svs8_id, VaultError::InvalidOracle);
        let mut entry = AssetEntry::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        if entry.vault == vault.key() && entry.index > removed_index {
            entry.index = entry.index.checked_sub(1).ok_or(VaultError::MathOverflow)?;
            let mut data = info.try_borrow_mut_data()?;
            entry.try_serialize(&mut &mut data[..])?;
        }
    }

    vault.num_assets = vault.num_assets
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    emit!(AssetRemoved {
        vault: vault.key(),
        asset_mint: asset_entry.asset_mint,
        index: removed_index,
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
