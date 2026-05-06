use anchor_lang::prelude::*;

#[error_code]
pub enum DeRwaError {
    #[msg("wrap amount must be greater than zero")]
    ZeroAmount = 8000,

    #[msg("unwrap requires a valid attestation on the destination wallet")]
    AttestationRequired = 8001,

    #[msg("locked supply mismatch: cannot unwrap more than locked")]
    InsufficientLockedSupply = 8002,

    #[msg("permissioned mint does not match wrapper config")]
    MintMismatch = 8003,

    #[msg("attestation account is not owned by the configured attestation program")]
    InvalidAttestationProgram = 8004,

    #[msg("attestation subject does not match the unwrapping investor")]
    InvalidAttestationSubject = 8005,

    #[msg("attestation issuer does not match the wrapper-configured issuer")]
    InvalidAttestationIssuer = 8006,

    #[msg("attestation type does not match the wrapper-required type")]
    InvalidAttestationType = 8007,

    #[msg("attestation account address does not match the canonical PDA derivation")]
    InvalidAttestationPda = 8008,

    #[msg("attestation_program / attestation_issuer must be set (non-default)")]
    InvalidAttestationConfig = 8009,

    #[msg("locked supply arithmetic overflow")]
    LockedSupplyOverflow = 8010,
}
