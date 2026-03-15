//! Streaming vault state account definition.

use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;
use crate::error::VaultError;
use crate::math;

#[account]
pub struct StreamVault {
    /// Vault admin who can pause/unpause, distribute yield, and transfer authority
    pub authority: Pubkey,
    /// Underlying asset mint
    pub asset_mint: Pubkey,
    /// LP token mint (shares, Token-2022)
    pub shares_mint: Pubkey,
    /// Token account holding assets
    pub asset_vault: Pubkey,
    /// Total assets at last checkpoint (excludes un-accrued stream yield)
    pub base_assets: u64,
    /// Yield amount distributing over current stream period
    pub stream_amount: u64,
    /// Unix timestamp when current stream began
    pub stream_start: i64,
    /// Unix timestamp when current stream ends
    pub stream_end: i64,
    /// Timestamp of last checkpoint
    pub last_checkpoint: i64,
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

impl StreamVault {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // authority
        32 +  // asset_mint
        32 +  // shares_mint
        32 +  // asset_vault
        8 +   // base_assets
        8 +   // stream_amount
        8 +   // stream_start
        8 +   // stream_end
        8 +   // last_checkpoint
        1 +   // decimals_offset
        1 +   // bump
        1 +   // paused
        8 +   // vault_id
        64; // _reserved

    pub const SEED_PREFIX: &'static [u8] = VAULT_SEED;

    /// SVS-5: Compute effective total assets with time-interpolated streaming yield.
    ///
    /// Returns `base_assets + accrued_stream_yield` where accrued yield is linearly
    /// interpolated between stream_start and stream_end. Floor rounding protects
    /// the vault from over-distribution.
    pub fn effective_total_assets(&self, now: i64) -> Result<u64> {
        if self.stream_amount == 0 || now <= self.stream_start {
            return Ok(self.base_assets);
        }

        if now >= self.stream_end {
            return self
                .base_assets
                .checked_add(self.stream_amount)
                .ok_or_else(|| error!(VaultError::MathOverflow));
        }

        // Linear interpolation: accrued = stream_amount * elapsed / duration (floor)
        let elapsed = now
            .checked_sub(self.stream_start)
            .ok_or(VaultError::MathOverflow)? as u64;
        let duration = self
            .stream_end
            .checked_sub(self.stream_start)
            .ok_or(VaultError::MathOverflow)? as u64;

        let accrued = math::mul_div(self.stream_amount, elapsed, duration, math::Rounding::Floor)?;

        self.base_assets
            .checked_add(accrued)
            .ok_or_else(|| error!(VaultError::MathOverflow))
    }

    /// Materialize accrued stream yield into base_assets.
    ///
    /// Returns the amount accrued. After checkpoint, `base_assets == effective_total_assets(now)`.
    /// Must be called before withdraw/redeem to prevent base_assets underflow.
    pub fn checkpoint(&mut self, now: i64) -> Result<u64> {
        if self.stream_amount == 0 {
            return Ok(0);
        }

        let effective = self.effective_total_assets(now)?;
        let accrued = effective
            .checked_sub(self.base_assets)
            .ok_or_else(|| error!(VaultError::MathOverflow))?;

        if accrued == 0 {
            return Ok(0);
        }

        self.base_assets = effective;

        if now >= self.stream_end {
            self.stream_amount = 0;
            self.stream_start = 0;
            self.stream_end = 0;
        } else {
            self.stream_amount = self
                .stream_amount
                .checked_sub(accrued)
                .ok_or_else(|| error!(VaultError::MathOverflow))?;
            self.stream_start = now;
        }

        self.last_checkpoint = now;
        Ok(accrued)
    }
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
