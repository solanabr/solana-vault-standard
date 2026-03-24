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
    // FIX P1: typed deserialization with owner + vault checks instead of raw byte offsets
    let svs8_id = crate::ID;
    let mut other_weights: u16 = 0;
    for info in ctx.remaining_accounts.iter() {
        require!(info.owner == &svs8_id, VaultError::InvalidOracle);
        let entry = AssetEntry::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        if entry.vault == vault_key && entry.asset_mint != asset_mint {
            other_weights = other_weights
                .checked_add(entry.target_weight_bps)
                .ok_or(VaultError::MathOverflow)?;
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
