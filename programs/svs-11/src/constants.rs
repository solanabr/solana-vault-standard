use anchor_lang::prelude::*;

pub const VAULT_SEED: &[u8] = b"credit_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const REDEMPTION_ESCROW_SEED: &[u8] = b"redemption_escrow";
pub const INVESTMENT_REQUEST_SEED: &[u8] = b"investment_request";
pub const REDEMPTION_REQUEST_SEED: &[u8] = b"redemption_request";
pub const CLAIMABLE_TOKENS_SEED: &[u8] = b"claimable_tokens";
pub const FROZEN_ACCOUNT_SEED: &[u8] = b"frozen_account";
pub const VAULT_CONFIG_SEED: &[u8] = b"vault_config";

/// Seed for the per-pool NavAccount PDA in the nav-oracle program.
/// Mirrors `nav_oracle::state::NavAccount::SEED_PREFIX`. Hard-coded here so
/// SVS-11 does not depend on the nav-oracle crate at compile time.
pub const NAV_ORACLE_SEED: &[u8] = b"nav_oracle";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const DEFAULT_MAX_DEVIATION_BPS: u16 = 500;
pub const MAX_DEVIATION_BPS_CAP: u16 = 2000;
pub const ORACLE_TIMELOCK: i64 = 86400; // 24 hours

/// Default per-pool maximum NAV staleness (45 days = 3,888,000 sec).
/// Written to CreditVault.max_nav_staleness_secs at initialize_pool
/// time; admin can update via update_oracle_params later.
pub const DEFAULT_MAX_NAV_STALENESS_SECS: i64 = 3_888_000;

/// Maximum future horizon (5 years = 157,680,000 sec) for a
/// manager-supplied `next_settlement_at`. Bounds operator footguns
/// where a stuck/malformed scheduler queues redemptions to year 9999;
/// downstream monitoring would otherwise flag them as "stuck forever"
/// indistinguishably from a real bug.
pub const MAX_SETTLEMENT_HORIZON_SECS: i64 = 157_680_000;

/// On-chain Program ID for the nav-oracle program. Used by SVS-11 to
/// derive + validate the NavAccount PDA in approve_deposit and
/// approve_redeem when CreditVault.oracle_source == 1. Kept in sync
/// with `programs/nav-oracle/src/lib.rs::declare_id!`.
pub const NAV_ORACLE_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7");

/// CreditVault.oracle_source values (emergency-revert toggle).
pub const ORACLE_SOURCE_MOCK: u8 = 0; // legacy mock_oracle path
pub const ORACLE_SOURCE_NAV_ORACLE: u8 = 1; // canonical path

// =============================================================================
// ComplianceHook + MockSas integration constants
// =============================================================================
//
// These constants are consumed by `initialize_pool` to:
//   - bind the cPOOL Token-2022 mint's TransferHook extension to
//     COMPLIANCE_HOOK_PROGRAM_ID;
//   - derive the per-mint MintConfig PDA owned by compliance-hook;
//   - CPI into compliance-hook's `initialize_extra_account_meta_list`;
//   - CPI into mock-sas's `create_attestation_with_metadata` for the
//     wrapper / vault / pool-admin infrastructure attestations.
//
// The values must stay in sync with `programs/compliance-hook/src/lib.rs`
// and `programs/mock-sas/src/lib.rs` declare_id! lines.

/// ComplianceHook program ID. cPOOL TransferHook extension authority
/// points here so all Token-2022 transfers route through the hook for
/// sanctions / frozen / Permissioned attestation enforcement.
pub const COMPLIANCE_HOOK_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P");

/// Mock-SAS (Solana Attestation Service mock) program ID.
/// `create_attestation_with_metadata` carries jurisdiction +
/// investor_class + kyc_risk_tier fields. We CPI into it from
/// `initialize_pool` for the wrapper / vault / pool-admin
/// infrastructure attestations the Permissioned hook check requires.
pub const MOCK_SAS_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("GTTMWDHTZibyEpqNRr33RnBhgms262U6qHaGrjoHqEXg");

/// Seed for compliance-hook's per-mint `MintConfig` PDA. Mirrors
/// `compliance_hook::state::MintConfig::SEED_PREFIX`.
pub const MINT_CONFIG_SEED: &[u8] = b"mint_config";

/// Seed for compliance-hook's per-mint `ExtraAccountMetaList` PDA. Note the
/// HYPHEN — the Token-2022 runtime spec is fixed on this exact literal.
/// Mirrors `compliance_hook::state::EXTRA_ACCOUNT_METAS_SEED`.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Seed for mock-sas's per-subject `Attestation` PDA. Mirrors the
/// literal hard-coded in `mock_sas::CreateAttestation`. Used by SVS-11
/// attestation validation + infrastructure-attestation creation.
pub const ATTESTATION_SEED: &[u8] = b"attestation";

/// `attestation_type` discriminator written to mock-sas attestations
/// created during `initialize_pool`. The metadata extension keeps `0`
/// reserved for the infrastructure tier (no policy enforcement; the
/// ComplianceHook treats zero metadata as wildcards in Permissioned
/// mode). Investor-tier attestations issued elsewhere use `> 0`.
pub const INFRASTRUCTURE_ATTESTATION_TYPE: u8 = 0;
