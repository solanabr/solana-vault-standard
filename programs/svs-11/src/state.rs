use anchor_lang::prelude::*;

use crate::constants::{INVESTMENT_REQUEST_SEED, REDEMPTION_REQUEST_SEED, VAULT_SEED};

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
    /// Cached share count. Updated atomically with mint/burn CPIs in
    /// claim_deposit (+) and approve_redeem (-). Drives share/asset conversion
    /// and the reconciliation check in approve_redeem (which has shares_mint in
    /// its context); callers with access to shares_mint should prefer
    /// shares_mint.supply as the canonical source.
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
    // Pluggable oracle interface
    // =========================================================================
    //
    // SVS-11 reads any SVS-compliant oracle through the generic 25-byte
    // `SvsOraclePrice` header (see `modules/svs-oracle`). The configured oracle
    // account address (`nav_oracle`) and its owner program (`oracle_program`)
    // identify which oracle the vault trusts; the vault enforces only generic
    // invariants (positive price, staleness, sequence monotonicity). Per-oracle
    // integrity (e.g. consecutive-price deviation) lives in the oracle program.
    /// Last oracle `sequence` the vault has consumed. Updated atomically by
    /// approve_deposit + approve_redeem after a successful oracle read.
    /// 0 on initialize_pool means "no sequence consumed yet". A sentinel
    /// `sequence == 0` from the oracle skips the monotonicity check.
    pub last_seen_nav_sequence: u64,

    /// Padding so the trailing block stays a clean multiple of 8. Reclaims the
    /// bytes freed by removing the legacy oracle-selector fields.
    pub _padding_oracle: [u8; 24],
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
        32 +  // pending_authority
        8 +   // total_pending_redeems
        1 +   // required_attestation_type
        23 +  // _reserved
        // ---- pluggable oracle interface (+32 bytes) ----
        8 +   // last_seen_nav_sequence
        24; // _padding_oracle

    /// Audit-friendly alias matching the spec language. Identical to `LEN`.
    pub const SPACE: usize = Self::LEN;

    pub const SEED_PREFIX: &'static [u8] = VAULT_SEED;
}

#[cfg(test)]
mod credit_vault_layout_tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    /// `nav-oracle::initialize` reads `CreditVault.authority` at on-disk
    /// bytes 8..40 (= post-discriminator payload bytes 0..32) to gate
    /// per-pool init against the squat-race attack. If this layout drifts
    /// — e.g. someone reorders the first field of `CreditVault` — the
    /// nav-oracle gate becomes a silent no-op (the byte slice still
    /// parses as 32 bytes, just into the wrong field). This test guards
    /// that invariant. Same shape as the layout test in `attestation.rs`.
    #[test]
    fn credit_vault_authority_offset_stable_for_nav_oracle_gate() {
        let authority = Pubkey::new_unique();
        let cv = CreditVault {
            authority,
            manager: Pubkey::new_unique(),
            asset_mint: Pubkey::new_unique(),
            shares_mint: Pubkey::new_unique(),
            deposit_vault: Pubkey::new_unique(),
            redemption_escrow: Pubkey::new_unique(),
            nav_oracle: Pubkey::new_unique(),
            oracle_program: Pubkey::new_unique(),
            max_staleness: 300,
            attester: Pubkey::new_unique(),
            attestation_program: Pubkey::new_unique(),
            vault_id: 1,
            total_assets: 0,
            total_shares: 0,
            total_pending_deposits: 0,
            minimum_investment: 0,
            investment_window_open: false,
            bump: 255,
            redemption_escrow_bump: 254,
            paused: false,
            total_approved_deposits: 0,
            pending_authority: Pubkey::default(),
            total_pending_redeems: 0,
            required_attestation_type: 0,
            _reserved: [0u8; 23],
            last_seen_nav_sequence: 0,
            _padding_oracle: [0u8; 24],
        };
        let bytes = cv.try_to_vec().expect("serialize");
        assert_eq!(
            &bytes[0..32],
            authority.as_ref(),
            "CreditVault.authority must remain at payload offset 0 (on-disk byte 8) — nav-oracle::initialize reads here"
        );
    }
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
        1; // bump

    pub const SEED_PREFIX: &'static [u8] = REDEMPTION_REQUEST_SEED;
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
