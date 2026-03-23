//! Custom oracle provider — simple [price_u64, updated_at_i64] format.
//! This matches the mock oracle format used by SVS-8 program.

use crate::error::OracleError;
use crate::provider::NormalizedPrice;

pub fn read_price(data: &[u8]) -> Result<NormalizedPrice, OracleError> {
    if data.len() < 16 {
        return Err(OracleError::InvalidPrice);
    }

    let price = u64::from_le_bytes(
        data[0..8]
            .try_into()
            .map_err(|_| OracleError::InvalidPrice)?,
    );
    let updated_at = i64::from_le_bytes(
        data[8..16]
            .try_into()
            .map_err(|_| OracleError::InvalidPrice)?,
    );

    Ok(NormalizedPrice {
        price,
        confidence: 0,
        updated_at,
    })
}
