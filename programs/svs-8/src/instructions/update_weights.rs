use crate::{
    error::VaultError,
    events::WeightsUpdated,
    state::{AssetEntry, MultiAssetVault},
};
use anchor_lang::prelude::*;

pub fn handler(ctx: Context<UpdateWeights>, new_weight_bps: u16) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let asset_mint = ctx.accounts.asset_entry.asset_mint;
    let old_weight = ctx.accounts.asset_entry.target_weight_bps;

    // Sum weights of all OTHER assets from remaining_accounts.
    // V5-P14 FIX: Validate remaining_accounts length matches expected count and
    // error on entries that don't belong to this vault instead of silently skipping.
    // Expected: num_assets - 1 (all assets except the one being updated).
    let expected_remaining = ctx
        .accounts
        .vault
        .num_assets
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)? as usize;
    require!(
        ctx.remaining_accounts.len() == expected_remaining,
        VaultError::AssetNotFound
    );

    let svs8_id = crate::ID;
    let mut other_weights: u16 = 0;
    for info in ctx.remaining_accounts.iter() {
        require!(info.owner == &svs8_id, VaultError::InvalidOracle);
        let entry = AssetEntry::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        require!(entry.vault == vault_key, VaultError::AssetNotFound);
        if entry.asset_mint != asset_mint {
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

    // Weights verified to sum to 10,000 — re-enable deposits
    ctx.accounts.vault.weights_valid = true;

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
    #[account(mut, has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,

    pub authority: Signer<'info>,

    #[account(mut, has_one = vault)]
    pub asset_entry: Account<'info, AssetEntry>,
}
