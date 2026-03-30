use anchor_lang::prelude::*;

/// SVS-9 Allocator Vault — top-level state.
///
/// Field order follows the official SVS-9 specification for
/// deterministic Borsh serialization and indexer compatibility.
///
/// Memory layout (after 8-byte Anchor discriminator):
/// | offset | size | field             |
/// |--------|------|-------------------|
/// |      8 |   32 | authority         |
/// |     40 |   32 | curator           |
/// |     72 |   32 | asset_mint        |
/// |    104 |   32 | shares_mint       |
/// |    136 |   32 | idle_vault        |
/// |    168 |    8 | vault_id          |
/// |    176 |    8 | total_shares      |
/// |    184 |    2 | idle_buffer_bps   |
/// |    186 |    1 | num_children      |
/// |    187 |    1 | decimals_offset   |
/// |    188 |    1 | bump              |
/// |    189 |    1 | paused            |
/// |    190 |   64 | _reserved         |
#[account]
#[derive(InitSpace)]
pub struct AllocatorVault {
    /// Vault admin — can pause, transfer authority, set curator
    pub authority: Pubkey,
    /// Curator — manages child vault allocations
    pub curator: Pubkey,
    /// Underlying asset mint
    pub asset_mint: Pubkey,
    /// LP token mint (shares) — always Token-2022
    pub shares_mint: Pubkey,
    /// ATA holding unallocated (idle) assets
    pub idle_vault: Pubkey,
    /// Unique vault identifier
    pub vault_id: u64,
    /// Total minted shares — tracked for ERC-4626 compliance
    pub total_shares: u64,
    /// Minimum idle ratio in bps
    pub idle_buffer_bps: u16,
    /// Number of active child vaults
    pub num_children: u8,
    /// Virtual offset exponent
    pub decimals_offset: u8,
    /// PDA bump seed
    pub bump: u8,
    /// Emergency pause flag
    pub paused: bool,
    /// Reserved for future upgrades — must be zeroed on init
    pub _reserved: [u8; 64],
}

/// Per-child allocation state — one PDA per (AllocatorVault, ChildVault) pair.
///
/// Memory layout (after 8-byte Anchor discriminator):
/// | offset | size | field                |
/// |--------|------|----------------------|
/// |      8 |   32 | allocator_vault      |
/// |     40 |   32 | child_vault          |
/// |     72 |   32 | child_program        |
/// |    104 |   32 | child_shares_account |
/// |    136 |    2 | target_weight_bps    |
/// |    138 |    2 | max_weight_bps       |
/// |    140 |    8 | deposited_assets     |
/// |    148 |    1 | index                |
/// |    149 |    1 | enabled              |
/// |    150 |    1 | child_decimals_offset|
/// |    151 |    1 | bump                 |
/// |    152 |   63 | _reserved            |
#[account]
#[derive(InitSpace)]
pub struct ChildAllocation {
    /// The allocator vault this allocation belongs to
    pub allocator_vault: Pubkey,
    /// The child vault pubkey
    pub child_vault: Pubkey,
    /// SVS program that owns the child vault
    pub child_program: Pubkey,
    /// ATA where the allocator holds its shares in the child vault
    pub child_shares_account: Pubkey,
    /// Target allocation weight in bps (informational, for rebalancing)
    pub target_weight_bps: u16,
    /// Maximum allocation weight in bps — enforced on allocate/rebalance
    pub max_weight_bps: u16,
    /// Cost-basis tracking: assets deposited into this child
    pub deposited_assets: u64,
    /// Position index within the allocator (0-based)
    pub index: u8,
    /// Whether this child is active
    pub enabled: bool,
    /// Inflation protection offset learned from child vault
    pub child_decimals_offset: u8,
    /// PDA bump seed
    pub bump: u8,
    /// Reserved for future upgrades — must be zeroed on init
    pub _reserved: [u8; 63],
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

    /// Cap configuration for vault.
    /// Seeds: ["cap_config", vault_pubkey]
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

    /// User deposit tracking for per-user caps.
    /// Seeds: ["user_deposit", vault_pubkey, user_pubkey]
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

    /// Lock configuration for vault.
    /// Seeds: ["lock_config", vault_pubkey]
    #[account]
    pub struct LockConfig {
        pub vault: Pubkey,
        pub lock_duration: i64,
        pub bump: u8,
    }

    impl LockConfig {
        pub const LEN: usize = 8 + 32 + 8 + 1;
    }

    /// Share lock for user.
    /// Seeds: ["share_lock", vault_pubkey, owner_pubkey]
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

    /// Access configuration for vault.
    /// Seeds: ["access_config", vault_pubkey]
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

    /// Frozen account marker.
    /// Seeds: ["frozen", vault_pubkey, user_pubkey]
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

    /// Reward configuration for vault.
    /// Seeds: ["reward_config", vault_pubkey, reward_mint_pubkey]
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

    /// User reward tracking.
    /// Seeds: ["user_reward", vault_pubkey, reward_mint_pubkey, user_pubkey]
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
