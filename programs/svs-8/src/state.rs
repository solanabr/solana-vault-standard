use anchor_lang::prelude::*;

/// Maximum number of assets in a basket vault.
pub const MAX_ASSETS: u8 = 8;

/// Maximum staleness for oracle prices (5 minutes).
pub const MAX_ORACLE_STALENESS: u64 = 300;

/// Maximum confidence interval for oracle prices (1% = 100 bps).
pub const MAX_ORACLE_CONFIDENCE_BPS: u64 = 100;

/// SVS-8 Multi-Asset Basket Vault.
///
/// Holds a basket of up to MAX_ASSETS SPL tokens.
/// A single share mint represents proportional ownership of the
/// entire portfolio, valued in a common base unit (e.g., USD).
///
/// PDA seeds: ["multi_vault", vault_id.to_le_bytes()]
#[account]
#[derive(Default)]
pub struct MultiAssetVault {
    /// Vault administrator (can add/remove assets, rebalance, pause).
    pub authority: Pubkey,         // 32
    /// Token-2022 share mint controlled by the vault PDA.
    pub shares_mint: Pubkey,       // 32
    /// Total outstanding share tokens (lamport units of the share mint).
    pub total_shares: u64,         // 8
    /// Decimal offset between share mint and base unit precision.
    /// share_price_base = total_portfolio_value * 10^decimals_offset / total_shares
    pub decimals_offset: u8,       // 1
    /// PDA bump.
    pub bump: u8,                  // 1
    /// Emergency pause flag. Blocks all financial operations when true.
    pub paused: bool,              // 1
    /// Unique vault identifier (used in PDA derivation).
    pub vault_id: u64,             // 8
    /// Current number of assets in the basket.
    pub num_assets: u8,            // 1
    /// Decimal precision for oracle-denominated values (e.g., 6 for USD).
    pub base_decimals: u8,         // 1
    /// Reserved space for future extensions.
    pub _reserved: [u8; 64],       // 64
}

impl MultiAssetVault {
    pub const LEN: usize = 8   // discriminator
        + 32  // authority
        + 32  // shares_mint
        + 8   // total_shares
        + 1   // decimals_offset
        + 1   // bump
        + 1   // paused
        + 8   // vault_id
        + 1   // num_assets
        + 1   // base_decimals
        + 64; // _reserved

    pub fn decimals_offset_factor(&self) -> u64 {
        10u64.pow(self.decimals_offset as u32)
    }
}

/// Describes one asset in the basket.
///
/// PDA seeds: ["asset_entry", vault_pda, asset_mint]
#[account]
#[derive(Default)]
pub struct AssetEntry {
    /// Parent vault PDA.
    pub vault: Pubkey,              // 32
    /// SPL token or Token-2022 mint.
    pub asset_mint: Pubkey,         // 32
    /// PDA-owned token account holding this asset.
    pub asset_vault: Pubkey,        // 32
    /// Price oracle account (Pyth, Switchboard, or svs-oracle).
    pub oracle: Pubkey,             // 32
    /// Target allocation in basis points (10_000 = 100%).
    pub target_weight_bps: u16,     // 2
    /// Decimal precision of this asset mint.
    pub asset_decimals: u8,         // 1
    /// Position index in the basket (0-indexed, max MAX_ASSETS-1).
    pub index: u8,                  // 1
    /// PDA bump.
    pub bump: u8,                   // 1
}

impl AssetEntry {
    pub const LEN: usize = 8   // discriminator
        + 32  // vault
        + 32  // asset_mint
        + 32  // asset_vault
        + 32  // oracle
        + 2   // target_weight_bps
        + 1   // asset_decimals
        + 1   // index
        + 1;  // bump

    /// Convert a raw token amount to the base-unit value using a normalized price.
    /// value = amount * price / 10^asset_decimals
    pub fn compute_value(&self, amount: u64, price_base_units: u64) -> Option<u64> {
        let numerator = (amount as u128).checked_mul(price_base_units as u128)?;
        let denominator = 10u128.pow(self.asset_decimals as u32);
        u64::try_from(numerator.checked_div(denominator)?).ok()
    }
}
