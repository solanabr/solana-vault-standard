use anchor_lang::prelude::*;
use solana_attestation_service_client::accounts::Attestation;

use crate::constants::SAS_PROGRAM_ID;
use crate::error::VaultError;
use crate::state::CreditVault;

pub fn validate_sas_attestation(
    attestation_info: &AccountInfo,
    vault: &CreditVault,
    investor: &Pubkey,
    clock: &Clock,
) -> Result<()> {
    require!(
        attestation_info.owner == &SAS_PROGRAM_ID,
        VaultError::InvalidAttestationProgram
    );

    let (expected_pda, _bump) = Pubkey::find_program_address(
        &[
            vault.sas_credential.as_ref(),
            vault.sas_schema.as_ref(),
            investor.as_ref(),
        ],
        &SAS_PROGRAM_ID,
    );
    require!(
        *attestation_info.key == expected_pda,
        VaultError::InvalidAttestation
    );

    let data = attestation_info.try_borrow_data()?;
    let attestation =
        Attestation::from_bytes(&data).map_err(|_| error!(VaultError::InvalidAttestation))?;

    require!(
        attestation.credential == vault.sas_credential,
        VaultError::InvalidCredential
    );

    require!(
        attestation.schema == vault.sas_schema,
        VaultError::InvalidSchema
    );

    if attestation.expiry > 0 {
        require!(
            attestation.expiry > clock.unix_timestamp,
            VaultError::AttestationExpired
        );
    }

    Ok(())
}
