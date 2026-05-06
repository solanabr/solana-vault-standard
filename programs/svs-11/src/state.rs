use anchor_lang::prelude::*;

use crate::constants::{
    FROZEN_ACCOUNT_SEED, INVESTMENT_REQUEST_SEED, REDEMPTION_REQUEST_SEED, VAULT_CONFIG_SEED,
    VAULT_SEED,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum AccessMode {
    #[default]
    Open,
    Whitelist,
    Blacklist,
}

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
    pub max_staleness: i64,
    pub attester: Pubkey,
    pub attestation_program: Pubkey,
    pub vault_id: u64,
    pub total_assets: u64,
    /// V4-P20: Cached share count. Updated atomically with mint/burn CPIs in
    /// claim_deposit (+) and approve_redeem (-). Used for NAV deviation checks
    /// in approve_deposit/approve_redeem. Callers with access to shares_mint
    /// should prefer shares_mint.supply as the canonical source. A reconciliation
    /// check is enforced in approve_redeem (which has shares_mint in its context).
    pub total_shares: u64,
    pub total_pending_deposits: u64,
    pub minimum_investment: u64,
    pub investment_window_open: bool,
    pub bump: u8,
    // Stored because the escrow lives for the vault's lifetime and is used in many CPIs.
    // claimable_tokens has no stored bump — its lifetime is single-instruction-pair
    // (approve_redeem → claim_redeem → close), so the bump is derived fresh each time.
    pub redemption_escrow_bump: u8,
    pub paused: bool,
    pub total_approved_deposits: u64,
    pub max_deviation_bps: u16,
    /// Pending authority for two-step transfer (default = Pubkey::default() means none)
    pub pending_authority: Pubkey,
    /// Number of pending (not yet approved/rejected/cancelled) redemption requests
    pub total_pending_redeems: u64,
    /// Required attestation_type that investor attestations must match.
    /// Default 0. Prevents a low-bar attestation (e.g. generic KYC) from
    /// satisfying a vault that semantically requires a higher-bar type
    /// (e.g. accredited investor) when the attester issues multiple types.
    pub required_attestation_type: u8,
    pub _reserved: [u8; 23],

    // =========================================================================
    // Oracle extensibility fields
    // =========================================================================
    //
    // SVS-11 keeps the simple oracle path as the neutral upstream default.
    // Deployments that need richer credit-market NAV semantics can opt into
    // the NavOracle adapter via `oracle_source = 1`. This is bounded
    // extensibility (simple oracle + known NavOracle add-on), not an
    // arbitrary plugin registry. Credit Markets deployments use the richer
    // adapter as deployment policy, not as a requirement imposed on every
    // upstream SVS-11 user.
    /// Last `NavAccount.sequence` the vault has consumed. Updated atomically by
    /// approve_deposit + approve_redeem after a successful NavOracle read.
    /// 0 on initialize_pool means "no sequence consumed yet".
    pub last_seen_nav_sequence: u64,

    /// Last `NavAccount.nav_net` the vault read. Used by the deviation guard so
    /// we don't accept a NAV that jumps more than `max_deviation_bps` from the
    /// prior reading. 0 on initialize_pool — first NavOracle read accepts any
    /// value and bootstraps the deviation baseline.
    pub last_seen_nav_price: u64,

    /// Per-pool maximum NAV staleness (seconds). Default 45 days =
    /// 3,888,000 sec (`DEFAULT_MAX_NAV_STALENESS_SECS`). NAV reads older
    /// than this trip `OracleStale` and block approve_deposit/approve_redeem.
    pub max_nav_staleness_secs: i64,

    /// Oracle source selector.
    ///   0 = simple/mock oracle path (neutral upstream default)
    ///   1 = nav_oracle adapter (optional rich credit-market NAV path)
    ///   2..255 = reserved → `OracleSourceInvalid`
    ///
    /// `initialize_pool` sets this to 0. Deployments that require rich NAV
    /// semantics call `set_oracle_source(1)` after initializing and publishing
    /// the pool's NavAccount.
    pub oracle_source: u8,

    /// Padding so the SPACE bump is a clean multiple of 8 (alignment friendliness).
    /// Total bump for the four fields above + this padding is exactly
    /// `8 + 8 + 8 + 1 + 7 = 32` bytes.
    pub _padding_oracle: [u8; 7],
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
        8 +   // max_staleness
        32 +  // attester
        32 +  // attestation_program
        8 +   // vault_id
        8 +   // total_assets
        8 +   // total_shares
        8 +   // total_pending_deposits
        8 +   // minimum_investment
        1 +   // investment_window_open
        1 +   // bump
        1 +   // redemption_escrow_bump
        1 +   // paused
        8 +   // total_approved_deposits
        2 +   // max_deviation_bps
        32 +  // pending_authority
        8 +   // total_pending_redeems
        1 +   // required_attestation_type
        23 +  // _reserved
        // ---- NavOracle integration (+32 bytes) ----
        8 +   // last_seen_nav_sequence
        8 +   // last_seen_nav_price
        8 +   // max_nav_staleness_secs
        1 +   // oracle_source
        7; // _padding_oracle

    /// Audit-friendly alias matching the spec language. Identical to `LEN`.
    pub const SPACE: usize = Self::LEN;

    pub const SEED_PREFIX: &'static [u8] = VAULT_SEED;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Pending,
    Approved,
}

#[account]
pub struct InvestmentRequest {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub amount_locked: u64,
    pub shares_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub bump: u8,
}

impl InvestmentRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // investor
        32 +  // vault
        8 +   // amount_locked
        8 +   // shares_claimable
        1 +   // status
        8 +   // requested_at
        8 +   // fulfilled_at
        1; // bump

    pub const SEED_PREFIX: &'static [u8] = INVESTMENT_REQUEST_SEED;
}

#[account]
pub struct RedemptionRequest {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub shares_locked: u64,
    pub assets_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub bump: u8,

    // =========================================================================
    // Pro-rata fulfillment + auto-requeue (+24 bytes)
    // =========================================================================
    //
    // These three fields support the rolling-notice settlement model
    // where a single RedemptionRequest may be partially fulfilled
    // across multiple settlement dates. `original_shares` snapshots the
    // initial intent (never changes). `fulfilled_shares_cumulative`
    // accumulates across one or more partial settlements.
    // `queued_for_settlement_at` is auto-bumped to the next settlement
    // epoch on partial fulfillment so the request stays in the queue
    // without a re-request from the investor.
    //
    // Realloc forward-reference: the +24 bytes break deserialization of
    // any RedemptionRequest PDA created before this upgrade. The drain
    // script empties existing PDAs pre-deploy and a per-pool pause flag
    // ensures no new PDAs land on the old layout during the deploy
    // window.
    /// Snapshot of `shares_locked` at first request (never changes after creation).
    /// Used by tests + analytics to compare original intent vs fulfilled cumulative.
    pub original_shares: u64,

    /// Settlement-date epoch this request is currently queued for. Auto-bumps
    /// to next scheduled date on partial fulfillment via `approve_redeem`.
    pub queued_for_settlement_at: i64,

    /// Cumulative shares fulfilled across one or more partial settlements.
    /// `fulfilled_shares_cumulative >= shares_locked` ⇒ request fully fulfilled.
    pub fulfilled_shares_cumulative: u64,
}

impl RedemptionRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // investor
        32 +  // vault
        8 +   // shares_locked
        8 +   // assets_claimable
        1 +   // status
        8 +   // requested_at
        8 +   // fulfilled_at
        1 +   // bump
        // ---- Pro-rata fulfillment fields (+24 bytes) ----
        8 +   // original_shares
        8 +   // queued_for_settlement_at
        8; // fulfilled_shares_cumulative

    pub const SEED_PREFIX: &'static [u8] = REDEMPTION_REQUEST_SEED;
}

#[account]
pub struct FrozenAccount {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub frozen_by: Pubkey,
    pub frozen_at: i64,
    pub bump: u8,
}

impl FrozenAccount {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // investor
        32 +  // vault
        32 +  // frozen_by
        8 +   // frozen_at
        1; // bump

    pub const SEED_PREFIX: &'static [u8] = FROZEN_ACCOUNT_SEED;
}

#[account]
pub struct VaultConfig {
    pub vault: Pubkey,              // 32
    pub pending_oracle: Pubkey,     // 32 - proposed new oracle
    pub oracle_change_at: i64,      // 8  - when the change can be applied
    pub compliance_officer: Pubkey, // 32 - separate compliance officer for freeze/unfreeze
    pub bump: u8,                   // 1
    pub _reserved: [u8; 31],        // future use (63 - 32 = 31)
}

impl VaultConfig {
    pub const LEN: usize = 8 + // discriminator
        32 +  // vault
        32 +  // pending_oracle
        8 +   // oracle_change_at
        32 +  // compliance_officer
        1 +   // bump
        31; // _reserved

    pub const SEED_PREFIX: &'static [u8] = VAULT_CONFIG_SEED;
}

// =============================================================================
// Module State Accounts (conditionally compiled with "modules" feature)
// =============================================================================

#[cfg(feature = "modules")]
pub mod module_state {
    use super::*;

    pub use svs_module_hooks::{
        ACCESS_CONFIG_SEED, CAP_CONFIG_SEED, FEE_CONFIG_SEED, LOCK_CONFIG_SEED,
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
}

#[cfg(feature = "modules")]
pub use module_state::*;
