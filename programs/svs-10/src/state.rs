//! Async vault state account definitions.

use anchor_lang::prelude::*;

use crate::constants::ASYNC_VAULT_SEED;

/// Main async vault account.
/// Seeds: ["async_vault", asset_mint, vault_id.to_le_bytes()]
#[account]
pub struct AsyncVault {
    /// Vault admin who can pause/unpause and transfer authority
    pub authority: Pubkey,
    /// Vault-level operator who can fulfill requests
    pub operator: Pubkey,
    /// Underlying asset mint
    pub asset_mint: Pubkey,
    /// LP token mint (shares) — always Token-2022
    pub shares_mint: Pubkey,
    /// Token account holding deposited assets (shared pool)
    pub asset_vault: Pubkey,
    /// Token account holding shares during pending redemptions
    pub share_escrow: Pubkey,
    /// Total shares outstanding (updated at fulfillment)
    pub total_shares: u64,
    /// Total assets under management (updated at fulfillment)
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

impl AsyncVault {
    pub const LEN: usize = 8  // discriminator
        + 32  // authority
        + 32  // operator
        + 32  // asset_mint
        + 32  // shares_mint
        + 32  // asset_vault
        + 32  // share_escrow
        + 8   // total_shares
        + 8   // total_assets
        + 1   // decimals_offset
        + 1   // bump
        + 1   // paused
        + 8   // vault_id
        + 64; // _reserved

    pub const SEED_PREFIX: &'static [u8] = ASYNC_VAULT_SEED;
}

/// Deposit request: records assets locked and shares owed.
/// Seeds: ["deposit_request", vault_pda, owner_pubkey]
#[account]
pub struct DepositRequest {
    /// Which vault this request belongs to
    pub vault: Pubkey,
    /// Who initiated the deposit request
    pub owner: Pubkey,
    /// Who will receive the minted shares
    pub receiver: Pubkey,
    /// Amount of assets locked in asset_vault
    pub assets_locked: u64,
    /// Shares to mint at claim (set at fulfillment, 0 while pending)
    pub shares_claimable: u64,
    /// Current status of this request
    pub status: RequestStatus,
    /// Unix timestamp when request was created
    pub requested_at: i64,
    /// Unix timestamp when request was fulfilled (0 while pending)
    pub fulfilled_at: i64,
    /// PDA bump seed
    pub bump: u8,
}

impl DepositRequest {
    pub const LEN: usize = 8  // discriminator
        + 32  // vault
        + 32  // owner
        + 32  // receiver
        + 8   // assets_locked
        + 8   // shares_claimable
        + 1   // status (enum)
        + 8   // requested_at
        + 8   // fulfilled_at
        + 1;  // bump
}

/// Redeem request: records shares locked and assets owed.
/// Seeds: ["redeem_request", vault_pda, owner_pubkey]
#[account]
pub struct RedeemRequest {
    /// Which vault this request belongs to
    pub vault: Pubkey,
    /// Who initiated the redeem request
    pub owner: Pubkey,
    /// Who will receive the redeemed assets
    pub receiver: Pubkey,
    /// Amount of shares locked in share_escrow
    pub shares_locked: u64,
    /// Assets to transfer at claim (set at fulfillment, 0 while pending)
    pub assets_claimable: u64,
    /// Current status of this request
    pub status: RequestStatus,
    /// Unix timestamp when request was created
    pub requested_at: i64,
    /// Unix timestamp when request was fulfilled (0 while pending)
    pub fulfilled_at: i64,
    /// PDA bump seed
    pub bump: u8,
}

impl RedeemRequest {
    pub const LEN: usize = 8  // discriminator
        + 32  // vault
        + 32  // owner
        + 32  // receiver
        + 8   // shares_locked
        + 8   // assets_claimable
        + 1   // status (enum)
        + 8   // requested_at
        + 8   // fulfilled_at
        + 1;  // bump
}

/// Per-user escrow tracking for claimable assets after redeem fulfillment.
/// Seeds: ["claimable", vault_pda, owner_pubkey]
#[account]
pub struct ClaimableEscrow {
    /// Which vault this belongs to
    pub vault: Pubkey,
    /// Owner of the claimable assets
    pub owner: Pubkey,
    /// Amount of assets available to claim
    pub amount: u64,
    /// PDA bump seed
    pub bump: u8,
}

impl ClaimableEscrow {
    pub const LEN: usize = 8  // discriminator
        + 32  // vault
        + 32  // owner
        + 8   // amount
        + 1;  // bump
}

/// Per-user operator approval for claiming on their behalf.
/// Seeds: ["operator_approval", vault_pda, owner_pubkey, operator_pubkey]
#[account]
pub struct OperatorApproval {
    /// Which vault this applies to
    pub vault: Pubkey,
    /// Who granted approval
    pub owner: Pubkey,
    /// Who received approval
    pub operator: Pubkey,
    /// Whether approval is active
    pub approved: bool,
    /// PDA bump seed
    pub bump: u8,
}

impl OperatorApproval {
    pub const LEN: usize = 8  // discriminator
        + 32  // vault
        + 32  // owner
        + 32  // operator
        + 1   // approved
        + 1;  // bump
}

/// Request lifecycle state machine.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    /// Request created, assets/shares locked, awaiting operator
    Pending,
    /// Operator processed request, ready to claim
    Fulfilled,
    /// User claimed shares/assets, account closed
    Claimed,
    /// User cancelled, escrowed tokens returned, account closed
    Cancelled,
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
}

#[cfg(feature = "modules")]
pub use module_state::*;
