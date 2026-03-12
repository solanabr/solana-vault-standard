use anchor_lang::prelude::*;

use crate::constants::CREDIT_VAULT_SEED;

#[account]
pub struct CreditVault {
    pub authority: Pubkey,
    pub manager: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub deposit_vault: Pubkey,
    pub redemption_escrow: Pubkey,
    pub nav_oracle: Pubkey,
    pub oracle_program: Pubkey,
    pub attester: Pubkey,
    pub attestation_program: Pubkey,
    pub total_assets: u64,
    pub total_shares: u64,
    pub minimum_investment: u64,
    pub investment_window_open: bool,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub max_staleness: i64,
    pub _reserved: [u8; 64],
}

impl CreditVault {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // authority
        32 +  // manager
        32 +  // asset_mint
        32 +  // shares_mint
        32 +  // deposit_vault
        32 +  // redemption_escrow
        32 +  // nav_oracle
        32 +  // oracle_program
        32 +  // attester
        32 +  // attestation_program
        8 +   // total_assets
        8 +   // total_shares
        8 +   // minimum_investment
        1 +   // investment_window_open
        1 +   // decimals_offset
        1 +   // bump
        1 +   // paused
        8 +   // vault_id
        8 +   // max_staleness
        64; // _reserved

    pub const SEED_PREFIX: &'static [u8] = CREDIT_VAULT_SEED;
}

#[account]
pub struct InvestmentRequest {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub amount_locked: u64,
    pub shares_to_receive: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub bump: u8,
}

impl InvestmentRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // investor
        32 +  // vault
        8 +   // amount_locked
        8 +   // shares_to_receive
        1 +   // status
        8 +   // requested_at
        1; // bump
}

#[account]
pub struct RedemptionRequest {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub shares_locked: u64,
    pub amount_claimable: u64,
    pub status: RedemptionStatus,
    pub requested_at: i64,
    pub bump: u8,
}

impl RedemptionRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // investor
        32 +  // vault
        8 +   // shares_locked
        8 +   // amount_claimable
        1 +   // status
        8 +   // requested_at
        1; // bump
}

#[account]
pub struct ClaimableEscrow {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub amount_claimable: u64,
    pub bump: u8,
}

impl ClaimableEscrow {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // investor
        32 +  // vault
        8 +   // amount_claimable
        1; // bump
}

#[account]
pub struct FrozenAccount {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub frozen_by: Pubkey,
    pub frozen_at: i64,
    pub bump: u8,
}

impl FrozenAccount {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // vault
        32 +  // investor
        32 +  // frozen_by
        8 +   // frozen_at
        1; // bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RedemptionStatus {
    Pending,
    Approved,
}

/// External attestation account (read-only, owned by attestation_program)
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Attestation {
    pub subject: Pubkey,
    pub issuer: Pubkey,
    pub attestation_type: u8,
    pub country_code: [u8; 2],
    pub issued_at: i64,
    pub expires_at: i64,
    pub revoked: bool,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl Attestation {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // subject
        32 +  // issuer
        1 +   // attestation_type
        2 +   // country_code
        8 +   // issued_at
        8 +   // expires_at
        1 +   // revoked
        1 +   // bump
        32; // _reserved
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
        ACCESS_CONFIG_SEED, CAP_CONFIG_SEED, FEE_CONFIG_SEED,
        FROZEN_ACCOUNT_SEED as MODULE_FROZEN_ACCOUNT_SEED, LOCK_CONFIG_SEED, SHARE_LOCK_SEED,
        USER_DEPOSIT_SEED,
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
    pub struct ModuleFrozenAccount {
        pub vault: Pubkey,
        pub user: Pubkey,
        pub frozen_by: Pubkey,
        pub frozen_at: i64,
        pub bump: u8,
    }

    impl ModuleFrozenAccount {
        pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 1;
    }
}

#[cfg(feature = "modules")]
pub use module_state::*;
