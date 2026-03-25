//! SVS-6 state definitions.
//!
//! The ConfidentialStreamVault is the main vault account.
//! Module state accounts (FeeConfig, CapConfig, etc.) are defined here with
//! program-specific #[account] macros, but use seed constants from svs-module-hooks.

use anchor_lang::prelude::*;

// Re-export module seeds and AccessMode from svs-module-hooks when modules feature is active
#[cfg(feature = "modules")]
pub use svs_module_hooks::state::{
    AccessMode, ACCESS_CONFIG_SEED, CAP_CONFIG_SEED, FEE_CONFIG_SEED, FROZEN_ACCOUNT_SEED,
    LOCK_CONFIG_SEED, SHARE_LOCK_SEED, USER_DEPOSIT_SEED,
};

// ═══════════════════════════════════════════════════════════════════
// Main Vault State
// ═══════════════════════════════════════════════════════════════════

/// SVS-6: Confidential Streaming Yield Vault
///
/// Combines SVS-5 streaming yield with SVS-3 confidential transfers.
///
/// Seeds: ["confidential_stream_vault", asset_mint, vault_id.to_le_bytes()]
/// Size:  286 bytes (+ 8-byte Anchor discriminator = 294 on-chain)
#[account]
pub struct ConfidentialStreamVault {
    // ── Core vault fields ──
    pub authority: Pubkey,        // 32
    pub asset_mint: Pubkey,       // 32
    pub shares_mint: Pubkey,      // 32
    pub asset_vault: Pubkey,      // 32
    pub decimals_offset: u8,      // 1
    pub bump: u8,                 // 1
    pub paused: bool,             // 1
    pub vault_id: u64,            // 8

    // ── Streaming fields (from SVS-5) ──
    pub base_assets: u64,         // 8 — settled total, updated by checkpoint + arithmetic
    pub total_shares: u64,        // 8 — plaintext aggregate
    pub stream_amount: u64,       // 8 — remaining yield to stream
    pub stream_start: i64,        // 8 — current stream start timestamp
    pub stream_end: i64,          // 8 — current stream end timestamp
    pub last_checkpoint: i64,     // 8 — last checkpoint timestamp

    // ── Confidential fields (from SVS-3) ──
    pub auditor_elgamal_pubkey: Option<[u8; 32]>, // 33 — optional compliance auditor
    pub confidential_authority: Pubkey,           // 32

    pub _reserved: [u8; 32],      // 32
}

impl ConfidentialStreamVault {
    pub const LEN: usize = 8 + 286; // discriminator + fields

    /// Calculate effective total assets at the current timestamp.
    /// effective = base_assets + accrued_streaming_yield
    pub fn effective_total_assets(&self, current_timestamp: i64) -> Result<u64> {
        if self.stream_amount == 0 || self.stream_end <= self.stream_start {
            return Ok(self.base_assets);
        }

        let duration = self
            .stream_end
            .checked_sub(self.stream_start)
            .ok_or(error!(crate::error::VaultError::MathOverflow))? as u128;

        let elapsed = current_timestamp
            .checked_sub(self.stream_start)
            .ok_or(error!(crate::error::VaultError::MathOverflow))?
            .max(0) as u128;

        let capped_elapsed = elapsed.min(duration);

        let accrued = (self.stream_amount as u128)
            .checked_mul(capped_elapsed)
            .ok_or(error!(crate::error::VaultError::MathOverflow))?
            .checked_div(duration)
            .ok_or(error!(crate::error::VaultError::DivisionByZero))? as u64;

        self.base_assets
            .checked_add(accrued)
            .ok_or_else(|| error!(crate::error::VaultError::MathOverflow))
    }
}

// ═══════════════════════════════════════════════════════════════════
// Module State Accounts (behind "modules" feature)
// ═══════════════════════════════════════════════════════════════════

#[cfg(feature = "modules")]
pub use module_state::*;

#[cfg(feature = "modules")]
mod module_state {
    use super::*;
    use svs_module_hooks::state::*;

    /// Fee configuration. Seeds: ["fee_config", vault]
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
        pub const LEN: usize = FEE_CONFIG_LEN;
    }

    /// Cap configuration. Seeds: ["cap_config", vault]
    #[account]
    pub struct CapConfig {
        pub vault: Pubkey,
        pub global_cap: u64,
        pub per_user_cap: u64,
        pub bump: u8,
    }

    impl CapConfig {
        pub const LEN: usize = CAP_CONFIG_LEN;
    }

    /// Per-user deposit tracking. Seeds: ["user_deposit", vault, user]
    #[account]
    pub struct UserDeposit {
        pub vault: Pubkey,
        pub user: Pubkey,
        pub cumulative_assets: u64,
        pub bump: u8,
    }

    impl UserDeposit {
        pub const LEN: usize = USER_DEPOSIT_LEN;
    }

    /// Lock configuration. Seeds: ["lock_config", vault]
    #[account]
    pub struct LockConfig {
        pub vault: Pubkey,
        pub lock_duration: i64,
        pub bump: u8,
    }

    impl LockConfig {
        pub const LEN: usize = LOCK_CONFIG_LEN;
    }

    /// Per-user share lock. Seeds: ["share_lock", vault, owner]
    #[account]
    pub struct ShareLock {
        pub vault: Pubkey,
        pub owner: Pubkey,
        pub locked_until: i64,
        pub bump: u8,
    }

    impl ShareLock {
        pub const LEN: usize = SHARE_LOCK_LEN;
    }

    /// Access control configuration. Seeds: ["access_config", vault]
    #[account]
    pub struct AccessConfig {
        pub vault: Pubkey,
        pub mode: AccessMode,
        pub merkle_root: [u8; 32],
        pub bump: u8,
    }

    impl AccessConfig {
        pub const LEN: usize = ACCESS_CONFIG_LEN;
    }

    /// Frozen account marker. Seeds: ["frozen", vault, user]
    #[account]
    pub struct FrozenAccount {
        pub vault: Pubkey,
        pub user: Pubkey,
        pub frozen_by: Pubkey,
        pub frozen_at: i64,
        pub bump: u8,
    }

    impl FrozenAccount {
        pub const LEN: usize = FROZEN_ACCOUNT_LEN;
    }
}
