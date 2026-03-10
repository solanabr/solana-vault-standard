//! Vault state account definitions.

use anchor_lang::prelude::*;

use crate::constants::{
    DEPOSIT_REQUEST_SEED, OPERATOR_APPROVAL_SEED, REDEEM_REQUEST_SEED, VAULT_SEED,
};

#[account]
pub struct AsyncVault {
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub vault_id: u64,
    pub total_assets: u64,
    pub total_shares: u64,
    pub total_pending_deposits: u64,
    pub decimals_offset: u8,
    pub paused: bool,
    pub max_staleness: i64,
    pub max_deviation_bps: u16,
    pub bump: u8,
    pub share_escrow_bump: u8,
    pub _reserved: [u8; 63],
}

impl AsyncVault {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // authority
        32 +  // operator
        32 +  // asset_mint
        32 +  // shares_mint
        32 +  // asset_vault
        8 +   // vault_id
        8 +   // total_assets
        8 +   // total_shares
        8 +   // total_pending_deposits
        1 +   // decimals_offset
        1 +   // paused
        8 +   // max_staleness
        2 +   // max_deviation_bps
        1 +   // bump
        1 +   // share_escrow_bump
        63; // _reserved

    pub const SEED_PREFIX: &'static [u8] = VAULT_SEED;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Pending,
    Fulfilled,
}

#[account]
pub struct DepositRequest {
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub vault: Pubkey,
    pub assets_locked: u64,
    pub shares_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub bump: u8,
}

impl DepositRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // owner
        32 +  // receiver
        32 +  // vault
        8 +   // assets_locked
        8 +   // shares_claimable
        1 +   // status
        8 +   // requested_at
        8 +   // fulfilled_at
        1; // bump

    pub const SEED_PREFIX: &'static [u8] = DEPOSIT_REQUEST_SEED;
}

#[account]
pub struct RedeemRequest {
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub vault: Pubkey,
    pub shares_locked: u64,
    pub assets_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub bump: u8,
}

impl RedeemRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // owner
        32 +  // receiver
        32 +  // vault
        8 +   // shares_locked
        8 +   // assets_claimable
        1 +   // status
        8 +   // requested_at
        8 +   // fulfilled_at
        1; // bump

    pub const SEED_PREFIX: &'static [u8] = REDEEM_REQUEST_SEED;
}

#[account]
pub struct OperatorApproval {
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub vault: Pubkey,
    pub can_fulfill_deposit: bool,
    pub can_fulfill_redeem: bool,
    pub can_claim: bool,
    pub bump: u8,
}

impl OperatorApproval {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // owner
        32 +  // operator
        32 +  // vault
        1 +   // can_fulfill_deposit
        1 +   // can_fulfill_redeem
        1 +   // can_claim
        1; // bump

    pub fn is_approved(&self) -> bool {
        self.can_fulfill_deposit || self.can_fulfill_redeem || self.can_claim
    }

    pub const SEED_PREFIX: &'static [u8] = OPERATOR_APPROVAL_SEED;
}

// =============================================================================
// Access Mode (always available for IDL generation)
// =============================================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum AccessMode {
    #[default]
    Open,
    Whitelist,
    Blacklist,
}

// =============================================================================
// Module State Accounts (conditionally compiled with "modules" feature)
// =============================================================================

#[cfg(feature = "modules")]
pub mod module_state {
    use super::*;

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
