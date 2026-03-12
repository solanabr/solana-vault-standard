use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::CreditVault;

/// Layout of the external oracle account. The oracle program must write this exact layout.
/// SVS-11 reads it as raw bytes (no CPI, no program dependency).
#[derive(Clone, Copy)]
#[repr(C)]
pub struct NavOracleData {
    pub price_per_share: u64,
    pub updated_at: i64,
}

impl NavOracleData {
    pub const LEN: usize = 8 + 8;

    /// Deserialize from raw account data, skipping the 8-byte Anchor discriminator.
    pub fn try_from_account(account: &AccountInfo) -> Result<Self> {
        let data = account.try_borrow_data()?;
        require!(data.len() == 8 + Self::LEN, VaultError::OracleInvalidPrice);
        let price_per_share = u64::from_le_bytes(
            data[8..16]
                .try_into()
                .map_err(|_| error!(VaultError::OracleInvalidPrice))?,
        );
        let updated_at = i64::from_le_bytes(
            data[16..24]
                .try_into()
                .map_err(|_| error!(VaultError::OracleInvalidPrice))?,
        );
        Ok(Self {
            price_per_share,
            updated_at,
        })
    }
}

pub fn read_and_validate_oracle(
    oracle_account: &AccountInfo,
    vault: &CreditVault,
    clock: &Clock,
) -> Result<u64> {
    require!(
        *oracle_account.key == vault.nav_oracle,
        VaultError::OracleInvalidPrice
    );
    require!(
        *oracle_account.owner == vault.oracle_program,
        VaultError::OracleInvalidProgram
    );
    let data = NavOracleData::try_from_account(oracle_account)?;
    crate::math::validate_oracle(
        data.price_per_share,
        data.updated_at,
        clock.unix_timestamp,
        vault.max_staleness,
    )?;
    Ok(data.price_per_share)
}
