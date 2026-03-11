use anchor_lang::prelude::*;

use crate::constants::{ASYNC_VAULT_SEED, ORACLE_PRICE_SEED};

#[account]
pub struct AsyncVault {
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub share_escrow: Pubkey,
    pub total_shares: u64,
    pub total_assets: u64,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub cancel_delay: i64,
    pub max_staleness: i64,
    pub _reserved: [u8; 64],
}

impl AsyncVault {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // authority
        32 +  // operator
        32 +  // asset_mint
        32 +  // shares_mint
        32 +  // asset_vault
        32 +  // share_escrow
        8 +   // total_shares
        8 +   // total_assets
        1 +   // decimals_offset
        1 +   // bump
        1 +   // paused
        8 +   // vault_id
        8 +   // cancel_delay
        8 +   // max_staleness
        64; // _reserved

    pub const SEED_PREFIX: &'static [u8] = ASYNC_VAULT_SEED;
}

#[account]
pub struct DepositRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub assets_locked: u64,
    pub shares_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub cancel_not_before: i64,
    pub bump: u8,
}

impl DepositRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // vault
        32 +  // owner
        32 +  // receiver
        8 +   // assets_locked
        8 +   // shares_claimable
        1 +   // status
        8 +   // requested_at
        8 +   // fulfilled_at
        8 +   // cancel_not_before
        1; // bump
}

#[account]
pub struct RedeemRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub shares_locked: u64,
    pub assets_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub cancel_not_before: i64,
    pub bump: u8,
}

impl RedeemRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // vault
        32 +  // owner
        32 +  // receiver
        8 +   // shares_locked
        8 +   // assets_claimable
        1 +   // status
        8 +   // requested_at
        8 +   // fulfilled_at
        8 +   // cancel_not_before
        1; // bump
}

#[account]
pub struct ClaimableEscrow {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

impl ClaimableEscrow {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // vault
        32 +  // owner
        8 +   // amount
        1; // bump
}

#[account]
pub struct OperatorApproval {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub can_fulfill_deposit: bool,
    pub can_fulfill_redeem: bool,
    pub can_claim: bool,
    pub bump: u8,
}

impl OperatorApproval {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // vault
        32 +  // owner
        32 +  // operator
        1 +   // can_fulfill_deposit
        1 +   // can_fulfill_redeem
        1 +   // can_claim
        1; // bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Pending,
    Fulfilled,
    Claimed,
    Cancelled,
}

#[account]
pub struct OraclePrice {
    pub vault: Pubkey,
    pub price: u64,
    pub updated_at: i64,
    pub authority: Pubkey,
    pub bump: u8,
}

impl OraclePrice {
    pub const LEN: usize = 8 + // discriminator
        32 +  // vault
        8 +   // price
        8 +   // updated_at
        32 +  // authority
        1; // bump

    pub const SEED_PREFIX: &'static [u8] = ORACLE_PRICE_SEED;
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
        LOCK_CONFIG_SEED, SHARE_LOCK_SEED, USER_DEPOSIT_SEED,
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
}

#[cfg(feature = "modules")]
pub use module_state::*;
