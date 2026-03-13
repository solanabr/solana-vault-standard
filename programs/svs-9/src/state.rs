//! State account definitions for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::constants::{
    ALLOCATOR_VAULT_SEED, CHILD_ALLOCATION_SEED, SHARES_MINT_SEED, IDLE_VAULT_SEED,
    MAX_CHILDREN, TOTAL_ASSETS_OFFSET, TOTAL_SHARES_OFFSET, DECIMALS_OFFSET_OFFSET,
};

#[account]
pub struct AllocatorVault {
    /// Vault admin who can pause/unpause and transfer authority.
    pub authority: Pubkey,
    /// Allocation manager who can allocate/deallocate/harvest.
    pub curator: Pubkey,
    /// Underlying asset mint (same for all children).
    pub asset_mint: Pubkey,
    /// Allocator share token mint.
    pub shares_mint: Pubkey,
    /// Token account holding unallocated assets.
    pub idle_vault: Pubkey,
    /// Total allocator shares issued.
    pub total_shares: u64,
    /// Number of child vault allocations.
    pub num_children: u8,
    /// Minimum % kept liquid for withdrawals (e.g., 500 = 5%).
    pub idle_buffer_bps: u16,
    /// Virtual offset exponent for inflation attack protection.
    pub decimals_offset: u8,
    /// Canonical vault bump.
    pub canonical_bump: u8, // FIXED: Store canonical bump (SVS-PDA compliance)
    pub bump: u8,
    /// Emergency pause flag.
    pub paused: bool,
    /// Unique vault identifier.
    pub vault_id: u64,
    /// Cached total assets for compute optimization.
    pub cached_total_assets: u64,
    /// Timestamp when cache was computed.
    pub cache_timestamp: i64,
    /// Reserved for future upgrades.
    pub _reserved: [u8; 64],
}

impl AllocatorVault {
    pub const LEN: usize = 8 +
        32 + // authority
        32 + // curator
        32 + // asset_mint
        32 + // shares_mint
        32 + // idle_vault
        8 +  // total_shares
        1 +  // num_children
        2 +  // idle_buffer_bps
        1 +  // decimals_offset
        1 +  // canonical_bump
        1 +  // bump
        1 +  // paused
        8 +  // vault_id
        8 +  // cached_total_assets
        8 +  // cache_timestamp
        63; // _reserved

    pub const SEED_PREFIX: &'static [u8] = ALLOCATOR_VAULT_SEED;

    /// Check if cached total assets are still valid
    pub fn is_cache_valid(&self, now: i64) -> bool {
        now.saturating_sub(self.cache_timestamp) <= crate::constants::TOTAL_ASSETS_CACHE_TTL_SECS
    }
    
    // FIXED: Add canonical bump storage (SVS-PDA compliance)
    pub fn validate_canonical_bump(&self, program_id: &Pubkey, seeds: &[&[u8]]) -> Result<bool> {
        let (expected_address, expected_bump) = Pubkey::find_program_address(seeds, program_id);
        
        Ok(self.key() == expected_address && self.canonical_bump == expected_bump)
    }
}

#[account]
pub struct ChildAllocation {
    /// Parent allocator vault.
    pub allocator_vault: Pubkey,
    /// Child vault being allocated to.
    pub child_vault: Pubkey,
    /// Program ID of child vault (for CPI validation).
    pub child_program: Pubkey,
    /// Allocator's share token account in child vault.
    pub child_shares_account: Pubkey,
    /// Target allocation weight (e.g., 3000 = 30%).
    pub target_weight_bps: u16,
    /// Hard cap on allocation weight.
    pub max_weight_bps: u16,
    /// Cumulative assets deposited into child.
    pub deposited_assets: u64,
    /// Index in the children array.
    pub index: u8,
    /// Whether curator can allocate to this child.
    pub enabled: bool,
    /// Canonical PDA bump.
    pub bump: u8,
}

impl ChildAllocation {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 2 + 2 + 8 + 1 + 1;

    pub const SEED_PREFIX: &'static [u8] = CHILD_ALLOCATION_SEED;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    Open,
    Whitelist,
    Blacklist,
}

#[cfg(feature = "modules")]
pub mod module_state {
    use super::*;

    pub use svs_module_hooks::{
        ACCESS_CONFIG_SEED, CAP_CONFIG_SEED, FEE_CONFIG_SEED, LOCK_CONFIG_SEED,
        REWARD_CONFIG_SEED, USER_DEPOSIT_SEED, USER_REWARD_SEED,
    };

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
    pub struct LockConfig {
        pub vault: Pubkey,
        pub lock_duration: i64,
        pub bump: u8,
    }

    impl LockConfig {
        pub const LEN: usize = 8 + 32 + 8 + 1;
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
    pub struct UserReward {
        pub vault: Pubkey,
        pub user: Pubkey,
        pub reward_mint: Pubkey,
        pub reward_debt: u128,
        pub unclaimed: u64,
        pub bump: u8,
    }

    impl UserReward {
        pub const LEN: usize = 8 + 32 + 32 + 16 + 8 + 1;
    }
}

#[cfg(feature = "modules")]
pub use module_state::*;
