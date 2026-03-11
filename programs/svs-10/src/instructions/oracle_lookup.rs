use anchor_lang::prelude::*;

use crate::{constants::ORACLE_PRICE_SEED, error::VaultError, state::OraclePrice};

/// Search remaining_accounts for a valid oracle price PDA.
///
/// Returns `Ok(Some((price, updated_at)))` if a valid oracle is found.
/// Returns `Ok(None)` if no oracle account is present in remaining_accounts.
/// Returns `Err` if the oracle account exists but is invalid (wrong owner,
/// bad discriminator, truncated data, or vault mismatch).
pub fn find_oracle_price<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    program_id: &Pubkey,
    vault_key: &Pubkey,
) -> Result<Option<(u64, i64)>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[ORACLE_PRICE_SEED, vault_key.as_ref()], program_id);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            // Defense-in-depth: verify the account is owned by this program
            require!(account.owner == program_id, VaultError::InvalidOraclePrice);

            let data = account.try_borrow_data()?;

            // If the PDA exists but data is truncated, error — don't silently
            // fall back to vault-priced mode. The operator intended oracle pricing.
            require!(
                data.len() >= OraclePrice::LEN,
                VaultError::InvalidOraclePrice
            );

            // Validate Anchor discriminator before deserializing
            let expected_disc: &[u8] = <OraclePrice as anchor_lang::Discriminator>::DISCRIMINATOR;
            require!(
                data[..8] == expected_disc[..],
                VaultError::InvalidOraclePrice
            );

            let oracle: OraclePrice = AnchorDeserialize::deserialize(&mut &data[8..])?;
            require!(oracle.vault == *vault_key, VaultError::OracleVaultMismatch);
            return Ok(Some((oracle.price, oracle.updated_at)));
        }
    }

    Ok(None)
}
