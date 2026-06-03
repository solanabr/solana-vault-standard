use anchor_lang::prelude::*;

pub const VAULT_SEED: &[u8] = b"credit_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const REDEMPTION_ESCROW_SEED: &[u8] = b"redemption_escrow";
pub const INVESTMENT_REQUEST_SEED: &[u8] = b"investment_request";
pub const REDEMPTION_REQUEST_SEED: &[u8] = b"redemption_request";
pub const CLAIMABLE_TOKENS_SEED: &[u8] = b"claimable_tokens";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;

/// Default per-pool maximum oracle staleness (45 days = 3,888,000 sec) and
/// the ceiling enforced by `update_oracle_params`. Callers pass the desired
/// window into `initialize_pool` (stored as `CreditVault.max_staleness`).
pub const DEFAULT_MAX_NAV_STALENESS_SECS: i64 = 3_888_000;

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
