//! Vault state account definitions.

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
    /// Unused in SVS-1 (live balance reads asset_vault.amount directly). Retained for struct compatibility.
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

    // Re-export seeds from shared crate
    pub use svs_module_hooks::{
        ACCESS_CONFIG_SEED, CAP_CONFIG_SEED, FEE_CONFIG_SEED, FROZEN_ACCOUNT_SEED,
        LOCK_CONFIG_SEED, REWARD_CONFIG_SEED, SHARE_LOCK_SEED, USER_DEPOSIT_SEED, USER_REWARD_SEED,
    };

    /// Fee configuration for vault.
    /// Seeds: ["fee_config", vault_pubkey]
    #[account]
    pub struct FeeConfig {
        /// Associated vault
        pub vault: Pubkey,
        /// Fee recipient address
        pub fee_recipient: Pubkey,
        /// Entry fee in basis points (max 1000 = 10%)
        pub entry_fee_bps: u16,
        /// Exit fee in basis points (max 1000 = 10%)
        pub exit_fee_bps: u16,
        /// Annual management fee in basis points (max 500 = 5%)
        pub management_fee_bps: u16,
        /// Performance fee in basis points (max 3000 = 30%)
        pub performance_fee_bps: u16,
        /// High water mark for performance fee (scaled by 1e9)
        pub high_water_mark: u64,
        /// Last time management fee was collected
        pub last_fee_collection: i64,
        /// PDA bump seed
        pub bump: u8,
    }

    impl FeeConfig {
        pub const LEN: usize = 8 + 32 + 32 + 2 + 2 + 2 + 2 + 8 + 8 + 1;
    }

    /// Cap configuration for vault.
    /// Seeds: ["cap_config", vault_pubkey]
    #[account]
    pub struct CapConfig {
        /// Associated vault
        pub vault: Pubkey,
        /// Global deposit cap (0 = unlimited)
        pub global_cap: u64,
        /// Per-user deposit cap (0 = unlimited)
        pub per_user_cap: u64,
        /// PDA bump seed
        pub bump: u8,
    }

    impl CapConfig {
        pub const LEN: usize = 8 + 32 + 8 + 8 + 1;
    }

    /// User deposit tracking for per-user caps.
    /// Seeds: ["user_deposit", vault_pubkey, user_pubkey]
    #[account]
    pub struct UserDeposit {
        /// Associated vault
        pub vault: Pubkey,
        /// User address
        pub user: Pubkey,
        /// Cumulative assets deposited
        pub cumulative_assets: u64,
        /// PDA bump seed
        pub bump: u8,
    }

    impl UserDeposit {
        pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
    }

    /// Lock configuration for vault.
    /// Seeds: ["lock_config", vault_pubkey]
    #[account]
    pub struct LockConfig {
        /// Associated vault
        pub vault: Pubkey,
        /// Lock duration in seconds
        pub lock_duration: i64,
        /// PDA bump seed
        pub bump: u8,
    }

    impl LockConfig {
        pub const LEN: usize = 8 + 32 + 8 + 1;
    }

    /// Share lock for user.
    /// Seeds: ["share_lock", vault_pubkey, owner_pubkey]
    #[account]
    pub struct ShareLock {
        /// Associated vault
        pub vault: Pubkey,
        /// Owner of locked shares
        pub owner: Pubkey,
        /// Timestamp when lock expires
        pub locked_until: i64,
        /// PDA bump seed
        pub bump: u8,
    }

    impl ShareLock {
        pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
    }

    /// Access configuration for vault.
    /// Seeds: ["access_config", vault_pubkey]
    #[account]
    pub struct AccessConfig {
        /// Associated vault
        pub vault: Pubkey,
        /// Access control mode
        pub mode: super::AccessMode,
        /// Merkle root for whitelist/blacklist
        pub merkle_root: [u8; 32],
        /// PDA bump seed
        pub bump: u8,
    }

    impl AccessConfig {
        pub const LEN: usize = 8 + 32 + 1 + 32 + 1;
    }

    /// Frozen account marker.
    /// Seeds: ["frozen", vault_pubkey, user_pubkey]
    #[account]
    pub struct FrozenAccount {
        /// Associated vault
        pub vault: Pubkey,
        /// Frozen user address
        pub user: Pubkey,
        /// Admin who froze the account
        pub frozen_by: Pubkey,
        /// Timestamp when frozen
        pub frozen_at: i64,
        /// PDA bump seed
        pub bump: u8,
    }

    impl FrozenAccount {
        pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 1;
    }

    /// Reward configuration for vault.
    /// Seeds: ["reward_config", vault_pubkey, reward_mint_pubkey]
    #[account]
    pub struct RewardConfig {
        /// Associated vault
        pub vault: Pubkey,
        /// Reward token mint
        pub reward_mint: Pubkey,
        /// Reward token vault
        pub reward_vault: Pubkey,
        /// Authority allowed to fund rewards
        pub reward_authority: Pubkey,
        /// Accumulated rewards per share (scaled by 1e18)
        pub accumulated_per_share: u128,
        /// Last update timestamp
        pub last_update: i64,
        /// PDA bump seed
        pub bump: u8,
    }

    impl RewardConfig {
        pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 16 + 8 + 1;
    }

    /// User reward tracking.
    /// Seeds: ["user_reward", vault_pubkey, reward_mint_pubkey, user_pubkey]
    #[account]
    pub struct UserReward {
        /// Associated vault
        pub vault: Pubkey,
        /// User address
        pub user: Pubkey,
        /// Reward token mint
        pub reward_mint: Pubkey,
        /// Reward debt (scaled by 1e18)
        pub reward_debt: u128,
        /// Unclaimed rewards
        pub unclaimed: u64,
        /// PDA bump seed
        pub bump: u8,
    }

    impl UserReward {
        pub const LEN: usize = 8 + 32 + 32 + 32 + 16 + 8 + 1;
    }
}

#[cfg(feature = "modules")]
pub use module_state::*;
