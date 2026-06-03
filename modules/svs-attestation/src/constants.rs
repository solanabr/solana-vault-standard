//! Canonical attestation account layout.
//!
//! Any SVS-compatible attestation program writes these fields, in this order,
//! immediately after the 8-byte Anchor discriminator. Offsets are
//! payload-relative (i.e. relative to the byte AFTER the discriminator).
//!
//! Byte 0 of the payload is a `version` tag at a FIXED position, checked by
//! `verify_attestation` before any other field is trusted — runtime drift
//! detection for the raw-offset cross-program reads. The layout is otherwise
//! additive-only: new data fields append after `kyc_risk_tier`; existing
//! offsets never shift.
//!
//! Payload layout (after the 8-byte discriminator):
//!     0        version          (u8, == ATTESTATION_VERSION)
//!     1..33    subject          (Pubkey)
//!    33..65    issuer           (Pubkey)
//!    65        attestation_type (u8)
//!    66..68    country_code     ([u8; 2])
//!    68..76    issued_at        (i64 LE)
//!    76..84    expires_at       (i64 LE)
//!    84        revoked          (bool)
//!    85        bump             (u8)
//!    86..118   _reserved        ([u8; 32])
//!   118..120   jurisdiction     ([u8; 2])
//!   120        investor_class   (u8)
//!   121        kyc_risk_tier    (u8)

/// Anchor discriminator length prefixing every attestation account.
pub const DISCRIMINATOR_LEN: usize = 8;

/// Current canonical layout version. `verify_attestation` rejects any other.
pub const ATTESTATION_VERSION: u8 = 1;

/// Payload-relative offset of `version` (u8).
pub const VERSION_OFFSET: usize = 0;
/// Payload-relative offset of `subject` (Pubkey).
pub const SUBJECT_OFFSET: usize = 1;
/// Payload-relative offset of `issuer` (Pubkey).
pub const ISSUER_OFFSET: usize = 33;
/// Payload-relative offset of `attestation_type` (u8).
pub const ATTESTATION_TYPE_OFFSET: usize = 65;
/// Payload-relative offset of `country_code` ([u8; 2]).
pub const COUNTRY_CODE_OFFSET: usize = 66;
/// Payload-relative offset of `issued_at` (i64 LE).
pub const ISSUED_AT_OFFSET: usize = 68;
/// Payload-relative offset of `expires_at` (i64 LE).
pub const EXPIRES_AT_OFFSET: usize = 76;
/// Payload-relative offset of `revoked` (bool).
pub const REVOKED_OFFSET: usize = 84;
/// Payload-relative offset of `bump` (u8).
pub const BUMP_OFFSET: usize = 85;
/// Payload-relative offset of `_reserved` ([u8; 32]).
pub const RESERVED_OFFSET: usize = 86;
/// Payload-relative offset of `jurisdiction` ([u8; 2]).
pub const JURISDICTION_OFFSET: usize = 118;
/// Payload-relative offset of `investor_class` (u8).
pub const INVESTOR_CLASS_OFFSET: usize = 120;
/// Payload-relative offset of `kyc_risk_tier` (u8).
pub const KYC_RISK_TIER_OFFSET: usize = 121;

/// Canonical payload length (all fields after the discriminator).
pub const ATTESTATION_PAYLOAD_LEN: usize = 122;
/// Full on-disk account length (discriminator + payload).
pub const ATTESTATION_ACCOUNT_LEN: usize = DISCRIMINATOR_LEN + ATTESTATION_PAYLOAD_LEN;

/// Canonical PDA seed prefix: `[b"attestation", subject, issuer, &[type], &[bump]]`.
pub const ATTESTATION_SEED_PREFIX: &[u8] = b"attestation";
