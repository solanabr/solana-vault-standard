//! Vault state account definitions.

use anchor_lang::prelude::*;

use crate::constants::SOL_VAULT_SEED;

/// SVS-7 Native SOL Vault state account (Live-only).
///
/// Seeds: ["sol_vault", vault_id.to_le_bytes()]
///
/// Accepts and returns native SOL. Internally uses a wSOL token account for
/// compatibility with DeFi protocols. The asset is always the native mint
/// (So11111111111111111111111111111111).
///
/// Total assets are always read directly from wsol_vault.amount — no stored
/// balance field, no sync instruction required.
#[account]
pub struct SolVault {
    /// Vault admin who can pause/unpause and transfer authority
    pub authority: Pubkey,
    /// Token-2022 LP/share token mint (PDA-owned, vault is mint authority)
    pub shares_mint: Pubkey,
    /// wSOL token account owned by the vault PDA
    pub wsol_vault: Pubkey,
    /// Virtual offset exponent. For SOL: 9 - 9 = 0, so offset = 10^0 = 1.
    pub decimals_offset: u8,
    /// PDA bump seed (stored for gas-efficient signer seeds)
    pub bump: u8,
    /// Emergency pause flag
    pub paused: bool,
    /// Unique vault identifier (allows multiple vaults per authority)
    pub vault_id: u64,
    /// Reserved for future upgrades (64 bytes)
    pub _reserved: [u8; 64],
}

impl SolVault {
    pub const LEN: usize = 8  // discriminator
        + 32  // authority
        + 32  // shares_mint
        + 32  // wsol_vault
        + 1   // decimals_offset
        + 1   // bump
        + 1   // paused
        + 8   // vault_id
        + 64; // _reserved

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
