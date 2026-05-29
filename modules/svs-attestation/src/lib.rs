//! SVS Attestation - KYC/KYB attestation interface for Solana Vault Standard.
//!
//! This crate is the attestation analogue of [`svs-oracle`]: it defines the
//! canonical on-disk layout for an attestation account and the verification
//! every SVS consumer must run, so the layout + checks live in ONE place
//! instead of being re-implemented (by byte offset) in each program.
//!
//! Attestation accounts are owned by a third-party attestation program (SAS,
//! Civic Pass, the bundled `mock-sas`, ...), never by the consuming vault, so
//! a typed Anchor `Account<T>` is impossible — consumers must read raw bytes.
//! This crate provides:
//! - the canonical byte offsets ([`constants`]),
//! - an offset parser ([`Attestation::from_account_data`]),
//! - the universal invariant check ([`check_invariants`]),
//! - and the full account-level verifier ([`verify_attestation`]) that binds
//!   owner + canonical PDA on top of the invariants.
//!
//! Each consumer maps the granular [`AttestationError`] onto its own error
//! enum, preserving program-specific error codes.
//!
//! [`svs-oracle`]: https://docs.rs/svs-oracle

mod attestation;
mod constants;
mod error;

pub use attestation::*;
pub use constants::*;
pub use error::AttestationError;
