//! Attestation module error types.
//!
//! Granular by design: each SVS consumer maps these onto its own program
//! error enum (e.g. svs-11's `InvalidAttester` vs compliance-hook's
//! `InvalidAttestationIssuer` both originate from [`AttestationError::IssuerMismatch`]).

/// Errors that can occur while parsing or verifying an attestation account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttestationError {
    /// Account is not owned by the configured attestation program.
    WrongOwner,
    /// Account data is missing or smaller than the canonical layout.
    Malformed,
    /// Attestation subject does not match the expected wallet.
    SubjectMismatch,
    /// Attestation issuer does not match the configured trust anchor.
    IssuerMismatch,
    /// Attestation type does not match the required type.
    WrongType,
    /// Attestation has been revoked.
    Revoked,
    /// Attestation has expired (or carries a non-positive expiry).
    Expired,
    /// Account address is not the canonical attestation PDA.
    InvalidPda,
}

impl core::fmt::Display for AttestationError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            AttestationError::WrongOwner => write!(f, "attestation account has wrong owner"),
            AttestationError::Malformed => write!(f, "attestation account data is malformed"),
            AttestationError::SubjectMismatch => write!(f, "attestation subject mismatch"),
            AttestationError::IssuerMismatch => write!(f, "attestation issuer mismatch"),
            AttestationError::WrongType => write!(f, "attestation type mismatch"),
            AttestationError::Revoked => write!(f, "attestation has been revoked"),
            AttestationError::Expired => write!(f, "attestation has expired"),
            AttestationError::InvalidPda => {
                write!(f, "attestation account is not the canonical PDA")
            }
        }
    }
}

impl std::error::Error for AttestationError {}
