//! Pyth oracle provider — reads from Pyth price feed account data.
//! Requires `pyth` feature flag.

use crate::error::OracleError;
use crate::provider::NormalizedPrice;

pub fn read_price(data: &[u8]) -> Result<NormalizedPrice, OracleError> {
    if data.len() < 16 {
        return Err(OracleError::InvalidPrice);
    }
    // TODO: Parse actual Pyth PriceFeed struct from data
    // This requires pyth-solana-receiver-sdk types
    Err(OracleError::UnsupportedOracleType)
}
