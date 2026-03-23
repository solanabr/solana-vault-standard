use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;

#[account]
pub struct MultiAssetVault {
    pub authority: Pubkey,
    pub shares_mint: Pubkey,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub num_assets: u8,
    pub base_decimals: u8,
    pub _reserved: [u8; 64],
}

impl MultiAssetVault {
    pub const LEN: usize = 8 + // discriminator
        32 +  // authority
        32 +  // shares_mint
        1 +   // decimals_offset
        1 +   // bump
        1 +   // paused
        8 +   // vault_id
        1 +   // num_assets
        1 +   // base_decimals
        64; // _reserved

    pub const SEED_PREFIX: &'static [u8] = VAULT_SEED;
}

#[account]
pub struct AssetEntry {
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub oracle: Pubkey,
    pub oracle_type: u8,
    pub target_weight_bps: u16,
    pub asset_decimals: u8,
    pub index: u8,
    pub bump: u8,
}

impl AssetEntry {
    pub const LEN: usize = 8 + // discriminator
        32 +  // vault
        32 +  // asset_mint
        32 +  // asset_vault
        32 +  // oracle
        1 +   // oracle_type
        2 +   // target_weight_bps
        1 +   // asset_decimals
        1 +   // index
        1; // bump
}
