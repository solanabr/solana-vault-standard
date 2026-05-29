//! Canonical attestation account layout.
//!
//! Any SVS-compatible attestation program writes these fields, in this order,
//! immediately after the 8-byte Anchor discriminator. Offsets are
//! payload-relative (i.e. relative to the byte AFTER the discriminator).
//! The field order is additive-only: new metadata fields append after
//! `kyc_risk_tier`; existing offsets never shift.
//!
//! Payload layout (after the 8-byte discriminator):
//!     0..32    subject          (Pubkey)
//!    32..64    issuer           (Pubkey)
//!    64        attestation_type (u8)
//!    65..67    country_code     ([u8; 2])
//!    67..75    issued_at        (i64 LE)
//!    75..83    expires_at       (i64 LE)
//!    83        revoked          (bool)
//!    84        bump             (u8)
//!    85..117   _reserved        ([u8; 32])
//!   117..119   jurisdiction     ([u8; 2])
//!   119        investor_class   (u8)
//!   120        kyc_risk_tier    (u8)

/// Anchor discriminator length prefixing every attestation account.
pub const DISCRIMINATOR_LEN: usize = 8;

/// Payload-relative offset of `subject` (Pubkey).
pub const SUBJECT_OFFSET: usize = 0;
/// Payload-relative offset of `issuer` (Pubkey).
pub const ISSUER_OFFSET: usize = 32;
/// Payload-relative offset of `attestation_type` (u8).
pub const ATTESTATION_TYPE_OFFSET: usize = 64;
/// Payload-relative offset of `country_code` ([u8; 2]).
pub const COUNTRY_CODE_OFFSET: usize = 65;
/// Payload-relative offset of `issued_at` (i64 LE).
pub const ISSUED_AT_OFFSET: usize = 67;
/// Payload-relative offset of `expires_at` (i64 LE).
pub const EXPIRES_AT_OFFSET: usize = 75;
/// Payload-relative offset of `revoked` (bool).
pub const REVOKED_OFFSET: usize = 83;
/// Payload-relative offset of `bump` (u8).
pub const BUMP_OFFSET: usize = 84;
/// Payload-relative offset of `_reserved` ([u8; 32]).
pub const RESERVED_OFFSET: usize = 85;
/// Payload-relative offset of `jurisdiction` ([u8; 2]).
pub const JURISDICTION_OFFSET: usize = 117;
/// Payload-relative offset of `investor_class` (u8).
pub const INVESTOR_CLASS_OFFSET: usize = 119;
/// Payload-relative offset of `kyc_risk_tier` (u8).
pub const KYC_RISK_TIER_OFFSET: usize = 120;

/// Canonical payload length (all fields after the discriminator).
pub const ATTESTATION_PAYLOAD_LEN: usize = 121;
/// Full on-disk account length (discriminator + payload).
pub const ATTESTATION_ACCOUNT_LEN: usize = DISCRIMINATOR_LEN + ATTESTATION_PAYLOAD_LEN;

/// Canonical PDA seed prefix: `[b"attestation", subject, issuer, &[type], &[bump]]`.
pub const ATTESTATION_SEED_PREFIX: &[u8] = b"attestation";
