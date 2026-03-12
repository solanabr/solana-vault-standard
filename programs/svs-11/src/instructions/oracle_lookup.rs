use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::Attestation;

/// Search remaining_accounts for a valid external NAV oracle price account.
///
/// Unlike SVS-10, the oracle is EXTERNAL (owned by vault.oracle_program, not this program).
/// Returns `Ok(Some((price, updated_at)))` if a valid oracle is found.
/// Returns `Ok(None)` if no oracle account is present in remaining_accounts.
/// Returns `Err` if the oracle account exists but is invalid.
pub fn find_oracle_price<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    oracle_program: &Pubkey,
    nav_oracle: &Pubkey,
    vault_key: &Pubkey,
) -> Result<Option<(u64, i64)>> {
    for account in remaining_accounts {
        if account.key() == *nav_oracle {
            require!(
                account.owner == oracle_program,
                VaultError::InvalidOraclePrice
            );

            let data = account.try_borrow_data()?;

            // OraclePrice: discriminator(8) + vault(32) + price(8) + updated_at(8) + authority(32) + bump(1) = 89
            require!(data.len() >= 89, VaultError::InvalidOraclePrice);

            // Validate Anchor discriminator for OraclePrice
            let expected_disc: [u8; 8] = {
                let hash = anchor_lang::solana_program::hash::hash(b"account:OraclePrice");
                let mut disc = [0u8; 8];
                disc.copy_from_slice(&hash.to_bytes()[..8]);
                disc
            };
            require!(
                data[..8] == expected_disc[..],
                VaultError::InvalidOraclePrice
            );

            // Validate oracle vault field matches current vault (defense-in-depth)
            let oracle_vault = Pubkey::new_from_array(
                data[8..40]
                    .try_into()
                    .map_err(|_| VaultError::InvalidOraclePrice)?,
            );
            require!(oracle_vault == *vault_key, VaultError::OracleVaultMismatch);

            // Deserialize price and updated_at from known offsets
            // Layout: disc(8) + vault(32) + price(8) + updated_at(8)
            let price = u64::from_le_bytes(
                data[40..48]
                    .try_into()
                    .map_err(|_| VaultError::InvalidOraclePrice)?,
            );
            let updated_at = i64::from_le_bytes(
                data[48..56]
                    .try_into()
                    .map_err(|_| VaultError::InvalidOraclePrice)?,
            );

            return Ok(Some((price, updated_at)));
        }
    }

    Ok(None)
}

/// Validate an external attestation account from remaining_accounts.
pub fn validate_attestation<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    attestation_program: &Pubkey,
    investor: &Pubkey,
    attester: &Pubkey,
    clock: &Clock,
) -> Result<()> {
    for account in remaining_accounts {
        if account.owner != attestation_program {
            continue;
        }

        let data = account.try_borrow_data()?;
        if data.len() < Attestation::LEN {
            continue;
        }

        // Validate discriminator for Attestation
        let expected_disc: [u8; 8] = {
            let hash = anchor_lang::solana_program::hash::hash(b"account:Attestation");
            let mut disc = [0u8; 8];
            disc.copy_from_slice(&hash.to_bytes()[..8]);
            disc
        };
        if data[..8] != expected_disc[..] {
            continue;
        }

        let attestation: Attestation = AnchorDeserialize::deserialize(&mut &data[8..])?;

        if attestation.subject != *investor {
            continue;
        }

        if attestation.issuer != *attester {
            continue;
        }

        require!(!attestation.revoked, VaultError::AttestationRevoked);
        if attestation.expires_at > 0 {
            require!(
                attestation.expires_at > clock.unix_timestamp,
                VaultError::AttestationExpired
            );
        }

        return Ok(());
    }

    Err(VaultError::AttestationNotFound.into())
}

/// Check if a FrozenAccount PDA exists for the given vault + investor.
/// Returns error if the account is frozen (PDA has data).
pub fn check_not_frozen<'info>(frozen_account_info: &AccountInfo<'info>) -> Result<()> {
    if !frozen_account_info.data_is_empty() {
        return Err(VaultError::AccountFrozen.into());
    }
    Ok(())
}
