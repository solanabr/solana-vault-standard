use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;

#[account]
pub struct Vault {
    /// Vault admin who can pause/unpause and transfer authority
    pub authority: Pubkey,
    /// Underlying asset mint
    pub asset_mint: Pubkey,
    /// LP token mint (shares)
    pub shares_mint: Pubkey,
    /// Token account holding assets
    pub asset_vault: Pubkey,
    /// Cached total assets (updated on deposit/withdraw, can be synced)
    pub total_assets: u64,
    /// Virtual offset exponent (9 - asset_decimals) for inflation attack protection
    pub decimals_offset: u8,
    /// PDA bump seed
    pub bump: u8,
    /// Emergency pause flag
    pub paused: bool,
    /// Unique vault identifier (allows multiple vaults per asset)
    pub vault_id: u64,
    /// Reserved for future upgrades
    pub _reserved: [u8; 64],
}

impl Vault {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // authority
        32 +  // asset_mint
        32 +  // shares_mint
        32 +  // asset_vault
        8 +   // total_assets
        1 +   // decimals_offset
        1 +   // bump
        1 +   // paused
        8 +   // vault_id
        64; // _reserved

    pub const SEED_PREFIX: &'static [u8] = VAULT_SEED;
}
