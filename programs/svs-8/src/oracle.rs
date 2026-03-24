use anchor_lang::prelude::*;

use crate::{constants::MAX_ORACLE_STALENESS, error::VaultError};

/// Read price from a mock oracle account format:
/// [price: u64 LE (8 bytes), updated_at: i64 LE (8 bytes)]
pub fn read_mock_oracle_price(data: &[u8], current_timestamp: i64) -> Result<u64> {
    if data.len() < 16 {
        return Err(error!(VaultError::OracleInvalid));
    }
    let price = u64::from_le_bytes(
        data[0..8]
            .try_into()
            .map_err(|_| error!(VaultError::OracleInvalid))?,
    );
    let updated_at = i64::from_le_bytes(
        data[8..16]
            .try_into()
            .map_err(|_| error!(VaultError::OracleInvalid))?,
    );

    require!(price > 0, VaultError::OracleInvalid);

    svs_oracle::validate_freshness(updated_at, current_timestamp, MAX_ORACLE_STALENESS)
        .map_err(|_| error!(VaultError::OracleStale))?;

    Ok(price)
}
