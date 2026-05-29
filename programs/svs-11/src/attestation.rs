use anchor_lang::prelude::*;
use svs_attestation::{verify_attestation, AttestationError};

use crate::error::VaultError;
use crate::state::CreditVault;

/// Map the shared module's granular error onto the vault's error codes.
fn map_attestation_err(e: AttestationError) -> VaultError {
    match e {
        AttestationError::WrongOwner => VaultError::InvalidAttestationProgram,
        AttestationError::IssuerMismatch => VaultError::InvalidAttester,
        AttestationError::Revoked => VaultError::AttestationRevoked,
        AttestationError::Expired => VaultError::AttestationExpired,
        AttestationError::Malformed
        | AttestationError::SubjectMismatch
        | AttestationError::WrongType
        | AttestationError::InvalidPda => VaultError::InvalidAttestation,
    }
}

/// Verify an external attestation account against the vault's trust anchors.
/// The canonical layout + checks live in the shared `svs-attestation` module
/// (the attestation analogue of `svs-oracle`), so every SVS consumer enforces
/// the same interface; this only maps the result onto `VaultError`.
pub fn validate_attestation(
    attestation_info: &AccountInfo,
    vault: &CreditVault,
    investor: &Pubkey,
    clock: &Clock,
) -> Result<()> {
    verify_attestation(
        attestation_info,
        &vault.attestation_program,
        investor,
        &vault.attester,
        vault.required_attestation_type,
        clock.unix_timestamp,
    )
    .map_err(|e| error!(map_attestation_err(e)))?;
    Ok(())
}
