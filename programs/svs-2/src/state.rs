//! Vault state account definition.

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

// =============================================================================
// Module State Accounts (conditionally compiled with "modules" feature)
// =============================================================================

#[cfg(feature = "modules")]
pub mod module_state {
    use super::*;

    pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";
    pub const CAP_CONFIG_SEED: &[u8] = b"cap_config";
    pub const USER_DEPOSIT_SEED: &[u8] = b"user_deposit";
    pub const LOCK_CONFIG_SEED: &[u8] = b"lock_config";
    pub const SHARE_LOCK_SEED: &[u8] = b"share_lock";
    pub const ACCESS_CONFIG_SEED: &[u8] = b"access_config";
    pub const FROZEN_ACCOUNT_SEED: &[u8] = b"frozen";
    pub const REWARD_CONFIG_SEED: &[u8] = b"reward_config";
    pub const USER_REWARD_SEED: &[u8] = b"user_reward";

    #[account]
    pub struct FeeConfig {
        pub vault: Pubkey,
        pub fee_recipient: Pubkey,
        pub entry_fee_bps: u16,
        pub exit_fee_bps: u16,
        pub management_fee_bps: u16,
        pub performance_fee_bps: u16,
        pub high_water_mark: u64,
        pub last_fee_collection: i64,
        pub bump: u8,
    }

    impl FeeConfig {
        pub const LEN: usize = 8 + 32 + 32 + 2 + 2 + 2 + 2 + 8 + 8 + 1;
    }

    #[account]
    pub struct CapConfig {
        pub vault: Pubkey,
        pub global_cap: u64,
        pub per_user_cap: u64,
        pub bump: u8,
    }

    impl CapConfig {
        pub const LEN: usize = 8 + 32 + 8 + 8 + 1;
    }

    #[account]
    pub struct UserDeposit {
        pub vault: Pubkey,
        pub user: Pubkey,
        pub cumulative_assets: u64,
        pub bump: u8,
    }

    impl UserDeposit {
        pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
    }

    #[account]
    pub struct LockConfig {
        pub vault: Pubkey,
        pub lock_duration: i64,
        pub bump: u8,
    }

    impl LockConfig {
        pub const LEN: usize = 8 + 32 + 8 + 1;
    }

    #[account]
    pub struct ShareLock {
        pub vault: Pubkey,
        pub owner: Pubkey,
        pub locked_until: i64,
        pub bump: u8,
    }

    impl ShareLock {
        pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
    }

    #[account]
    pub struct AccessConfig {
        pub vault: Pubkey,
        pub mode: super::AccessMode,
        pub merkle_root: [u8; 32],
        pub bump: u8,
    }

    impl AccessConfig {
        pub const LEN: usize = 8 + 32 + 1 + 32 + 1;
    }

    #[account]
    pub struct FrozenAccount {
        pub vault: Pubkey,
        pub user: Pubkey,
        pub frozen_by: Pubkey,
        pub frozen_at: i64,
        pub bump: u8,
    }

    impl FrozenAccount {
        pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 1;
    }

    #[account]
    pub struct RewardConfig {
        pub vault: Pubkey,
        pub reward_mint: Pubkey,
        pub reward_vault: Pubkey,
        pub reward_authority: Pubkey,
        pub accumulated_per_share: u128,
        pub last_update: i64,
        pub bump: u8,
    }

    impl RewardConfig {
        pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 16 + 8 + 1;
    }

    #[account]
    pub struct UserReward {
        pub vault: Pubkey,
        pub user: Pubkey,
        pub reward_mint: Pubkey,
        pub reward_debt: u128,
        pub unclaimed: u64,
        pub bump: u8,
    }

    impl UserReward {
        pub const LEN: usize = 8 + 32 + 32 + 32 + 16 + 8 + 1;
    }
}

#[cfg(feature = "modules")]
pub use module_state::*;
