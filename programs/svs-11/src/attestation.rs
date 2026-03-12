use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::CreditVault;

/// External attestation account layout (owned by any attestation program).
/// Matches the spec's generic interface — compatible with SAS, Civic Pass, or
/// any provider that writes accounts in this format.
#[derive(AnchorDeserialize)]
pub struct Attestation {
    pub subject: Pubkey,
    pub issuer: Pubkey,
    pub attestation_type: u8,
    pub country_code: [u8; 2],
    pub issued_at: i64,
    pub expires_at: i64,
    pub revoked: bool,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl Attestation {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 2 + 8 + 8 + 1 + 1 + 32;
}

pub fn validate_attestation(
    attestation_info: &AccountInfo,
    vault: &CreditVault,
    investor: &Pubkey,
    clock: &Clock,
) -> Result<()> {
    require!(
        attestation_info.owner == &vault.attestation_program,
        VaultError::InvalidAttestationProgram
    );

    let data = attestation_info.try_borrow_data()?;
    // Skip 8-byte Anchor discriminator
    let attestation = Attestation::try_from_slice(&data[8..])
        .map_err(|_| error!(VaultError::InvalidAttestation))?;

    require!(
        attestation.subject == *investor,
        VaultError::InvalidAttestation
    );

    require!(
        attestation.issuer == vault.attester,
        VaultError::InvalidAttester
    );

    require!(!attestation.revoked, VaultError::AttestationRevoked);

    if attestation.expires_at > 0 {
        require!(
            attestation.expires_at > clock.unix_timestamp,
            VaultError::AttestationExpired
        );
    }

    Ok(())
}
