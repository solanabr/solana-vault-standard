//! Vault state account definitions.

use anchor_lang::prelude::*;

use crate::constants::SOL_VAULT_SEED;

/// Balance model determines how total_assets is read.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum BalanceModel {
    /// Live: reads wsol_vault.amount directly (no sync needed)
    Live = 0,
    /// Stored: uses vault.total_assets field, requires sync() to update
    Stored = 1,
}

impl Default for BalanceModel {
    fn default() -> Self {
        BalanceModel::Live
    }
}

#[account]
pub struct SolVault {
    /// Vault admin who can pause/unpause, sync, and transfer authority
    pub authority: Pubkey,
    /// LP token mint (shares) - Token-2022
    pub shares_mint: Pubkey,
    /// PDA-owned wSOL token account for internal accounting
    pub wsol_vault: Pubkey,
    /// Tracked total assets in lamports (used by Stored model; informational for Live)
    pub total_assets: u64,
    /// Virtual offset exponent: SOL has 9 decimals, so offset = 9 - 9 = 0
    pub decimals_offset: u8,
    /// PDA bump seed
    pub bump: u8,
    /// Emergency pause flag
    pub paused: bool,
    /// Unique vault identifier (allows multiple SOL vaults)
    pub vault_id: u64,
    /// Balance model: Live or Stored
    pub balance_model: BalanceModel,
    /// Reserved for future upgrades
    pub _reserved: [u8; 64],
}

impl SolVault {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // authority
        32 +  // shares_mint
        32 +  // wsol_vault
        8 +   // total_assets
        1 +   // decimals_offset
        1 +   // bump
        1 +   // paused
        8 +   // vault_id
        1 +   // balance_model
        64;   // _reserved

    pub const SEED_PREFIX: &'static [u8] = SOL_VAULT_SEED;
}

// =============================================================================
// Access Mode (always available for IDL generation)
// =============================================================================

/// Access mode enum - always exported for IDL compatibility.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum AccessMode {
    /// Open access - anyone can interact
    #[default]
    Open,
    /// Whitelist - only addresses with valid merkle proofs
    Whitelist,
    /// Blacklist - anyone except addresses with valid merkle proofs
    Blacklist,
}
