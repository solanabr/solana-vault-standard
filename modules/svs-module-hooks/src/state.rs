//! Module PDA seed constants and shared types.
//!
//! State account structs remain in each program's state.rs (requires `#[account]`
//! with program-specific `declare_id!`). This module exports only the seed
//! constants and AccessMode enum that are identical across all programs.

use anchor_lang::prelude::*;

// =============================================================================
// Access Mode (shared across all vault programs)
// =============================================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum AccessMode {
    #[default]
    Open,
    Whitelist,
    Blacklist,
}

// =============================================================================
// PDA Seed Constants
// =============================================================================

pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";
pub const CAP_CONFIG_SEED: &[u8] = b"cap_config";
pub const USER_DEPOSIT_SEED: &[u8] = b"user_deposit";
pub const LOCK_CONFIG_SEED: &[u8] = b"lock_config";
pub const SHARE_LOCK_SEED: &[u8] = b"share_lock";
pub const ACCESS_CONFIG_SEED: &[u8] = b"access_config";
pub const FROZEN_ACCOUNT_SEED: &[u8] = b"frozen";
pub const REWARD_CONFIG_SEED: &[u8] = b"reward_config";
pub const USER_REWARD_SEED: &[u8] = b"user_reward";

// =============================================================================
// Account Sizes (discriminator + fields)
// =============================================================================

pub const FEE_CONFIG_LEN: usize = 8 + 32 + 32 + 2 + 2 + 2 + 2 + 8 + 8 + 1;
pub const CAP_CONFIG_LEN: usize = 8 + 32 + 8 + 8 + 1;
pub const USER_DEPOSIT_LEN: usize = 8 + 32 + 32 + 8 + 1;
pub const LOCK_CONFIG_LEN: usize = 8 + 32 + 8 + 1;
pub const SHARE_LOCK_LEN: usize = 8 + 32 + 32 + 8 + 1;
pub const ACCESS_CONFIG_LEN: usize = 8 + 32 + 1 + 32 + 1;
pub const FROZEN_ACCOUNT_LEN: usize = 8 + 32 + 32 + 32 + 8 + 1;
pub const REWARD_CONFIG_LEN: usize = 8 + 32 + 32 + 32 + 32 + 16 + 8 + 1;
pub const USER_REWARD_LEN: usize = 8 + 32 + 32 + 32 + 16 + 8 + 1;
