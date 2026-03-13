use anchor_lang::prelude::*;
use crate::{
    error::VaultError,
    events::WeightsUpdated,
    state::{AssetEntry, MultiAssetVault},
};

pub fn handler(ctx: Context<UpdateWeights>, new_weight_bps: u16) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let asset_mint = ctx.accounts.asset_entry.asset_mint;
    let old_weight = ctx.accounts.asset_entry.target_weight_bps;

    // Sum weights of all OTHER assets from remaining_accounts
    let mut other_weights: u16 = 0;
    for i in 0..ctx.remaining_accounts.len() {
        let info = ctx.remaining_accounts.get(i).ok_or(VaultError::AssetNotFound)?;
        let data = info.try_borrow_data()?;
        if data.len() >= 8 + 32 + 32 + 32 + 32 + 2 {
            let entry_vault_bytes: [u8; 32] = data[8..8+32].try_into()
                .map_err(|_| VaultError::MathOverflow)?;
            let entry_mint_bytes: [u8; 32] = data[8+32..8+32+32].try_into()
                .map_err(|_| VaultError::MathOverflow)?;
            let weight_bytes: [u8; 2] = data[8+32+32+32+32..8+32+32+32+32+2].try_into()
                .map_err(|_| VaultError::MathOverflow)?;

            if entry_vault_bytes == vault_key.to_bytes()
                && entry_mint_bytes != asset_mint.to_bytes()
            {
                let weight = u16::from_le_bytes(weight_bytes);
                other_weights = other_weights
                    .checked_add(weight)
                    .ok_or(VaultError::MathOverflow)?;
            }
        }
    }

    let new_total = other_weights
        .checked_add(new_weight_bps)
        .ok_or(VaultError::MathOverflow)?;
    require!(new_total == 10_000, VaultError::InvalidWeight);

    ctx.accounts.asset_entry.target_weight_bps = new_weight_bps;

    emit!(WeightsUpdated {
        vault: vault_key,
        asset_mint,
        old_weight_bps: old_weight,
        new_weight_bps,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateWeights<'info> {
    #[account(has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,

    pub authority: Signer<'info>,

    #[account(mut, has_one = vault)]
    pub asset_entry: Account<'info, AssetEntry>,
}
