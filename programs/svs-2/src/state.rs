use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;

#[account]
pub struct ConfidentialVault {
    /// Vault admin who can pause/unpause and transfer authority
    pub authority: Pubkey,
    /// Underlying asset mint
    pub asset_mint: Pubkey,
    /// LP token mint (shares) - Token-2022 with ConfidentialTransferMint extension
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
    /// Optional auditor ElGamal public key for compliance (32 bytes if Some)
    pub auditor_elgamal_pubkey: Option<[u8; 32]>,
    /// Authority for confidential transfer operations
    pub confidential_authority: Pubkey,
    /// Reserved for future upgrades
    pub _reserved: [u8; 32],
}

impl ConfidentialVault {
    pub const LEN: usize = 8 +   // discriminator
        32 +  // authority
        32 +  // asset_mint
        32 +  // shares_mint
        32 +  // asset_vault
        8 +   // total_assets
        1 +   // decimals_offset
        1 +   // bump
        1 +   // paused
        8 +   // vault_id
        1 + 32 + // auditor_elgamal_pubkey (Option<[u8; 32]>)
        32 +  // confidential_authority
        32; // _reserved

    pub const SEED_PREFIX: &'static [u8] = VAULT_SEED;
}
