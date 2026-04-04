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
    require!(data.len() >= 8, VaultError::InvalidAttestation);
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

    require!(attestation.expires_at > 0, VaultError::InvalidAttestation);
    require!(
        attestation.expires_at > clock.unix_timestamp,
        VaultError::AttestationExpired
    );

    // Enforce attestation_type matches vault's required type. Prevents a low-bar
    // attestation (e.g. generic KYC) from satisfying a vault that semantically
    // requires a different type when the attester issues multiple types.
    require!(
        attestation.attestation_type == vault.required_attestation_type,
        VaultError::InvalidAttestation
    );

    // Verify the attestation account is a canonical PDA derived under the
    // attestation program. Seed convention: [b"attestation", subject, issuer, attestation_type].
    let expected_pda = Pubkey::create_program_address(
        &[
            b"attestation",
            investor.as_ref(),
            attestation.issuer.as_ref(),
            &[attestation.attestation_type],
            &[attestation.bump],
        ],
        &vault.attestation_program,
    )
    .map_err(|_| error!(VaultError::InvalidAttestation))?;
    require!(
        attestation_info.key() == expected_pda,
        VaultError::InvalidAttestation
    );

    Ok(())
}
