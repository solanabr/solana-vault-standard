use anchor_lang::prelude::*;
use crate::constants::{MULTI_VAULT_SEED, ASSET_ENTRY_SEED};

/// Main vault account holding basket metadata
/// Seeds: ["multi_vault", vault_id.to_le_bytes()]
#[account]
pub struct MultiAssetVault {
    /// Vault admin
    pub authority: Pubkey,
    /// LP share token mint (Token-2022)
    pub shares_mint: Pubkey,
    /// Total shares in circulation
    pub total_shares: u64,
    /// Virtual offset exponent for inflation attack protection
    pub decimals_offset: u8,
    /// PDA bump seed
    pub bump: u8,
    /// Emergency pause flag
    pub paused: bool,
    /// Unique vault identifier
    pub vault_id: u64,
    /// Number of assets currently in basket (max 8)
    pub num_assets: u8,
    /// Decimal precision for portfolio value (e.g. 6 for USD)
    pub base_decimals: u8,
    /// Reserved for future upgrades
    pub _reserved: [u8; 64],
}

impl MultiAssetVault {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // authority
        32 +  // shares_mint
        8 +   // total_shares
        1 +   // decimals_offset
        1 +   // bump
        1 +   // paused
        8 +   // vault_id
        1 +   // num_assets
        1 +   // base_decimals
        64;   // _reserved

    pub const SEED_PREFIX: &'static [u8] = MULTI_VAULT_SEED;
}

/// Per-asset entry in the basket
/// Seeds: ["asset_entry", vault_pubkey, asset_mint_pubkey]
#[account]
pub struct AssetEntry {
    /// Parent vault
    pub vault: Pubkey,
    /// Asset token mint
    pub asset_mint: Pubkey,
    /// PDA-owned token account holding this asset
    pub asset_vault: Pubkey,
    /// Price oracle account (Pyth)
    pub oracle: Pubkey,
    /// Target allocation in basis points (10000 = 100%)
    pub target_weight_bps: u16,
    /// Token decimals for this asset
    pub asset_decimals: u8,
    /// Position index in basket (0-indexed)
    pub index: u8,
    /// PDA bump seed
    pub bump: u8,
}

impl AssetEntry {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // vault
        32 +  // asset_mint
        32 +  // asset_vault
        32 +  // oracle
        2 +   // target_weight_bps
        1 +   // asset_decimals
        1 +   // index
        1;    // bump

    pub const SEED_PREFIX: &'static [u8] = ASSET_ENTRY_SEED;
}

/// Oracle price account for each asset
/// Seeds: ["oracle_price", vault_pubkey, asset_mint_pubkey]
#[account]
pub struct OraclePrice {
    /// Parent vault
    pub vault: Pubkey,
    /// Asset mint this price applies to
    pub asset_mint: Pubkey,
    /// Price scaled by PRICE_SCALE (1e9)
    /// e.g. USDC = 1_000_000_000, SOL = 150_000_000_000
    pub price: u64,
    /// When this price was last updated (Unix timestamp)
    pub updated_at: i64,
    /// Authority that can update this price
    pub authority: Pubkey,
    /// PDA bump
    pub bump: u8,
}

impl OraclePrice {
    pub const LEN: usize = 8 +  // discriminator
        32 + // vault
        32 + // asset_mint
        8 +  // price
        8 +  // updated_at
        32 + // authority
        1;   // bump

    pub const SEED_PREFIX: &'static [u8] = b"oracle_price";
}
