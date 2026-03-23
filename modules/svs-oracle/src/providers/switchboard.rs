//! Switchboard oracle provider — reads from Switchboard V2 aggregator data.
//! Requires `switchboard` feature flag.

use crate::error::OracleError;
use crate::provider::NormalizedPrice;

pub fn read_price(data: &[u8]) -> Result<NormalizedPrice, OracleError> {
    if data.len() < 16 {
        return Err(OracleError::InvalidPrice);
    }
    // TODO: Parse actual Switchboard AggregatorAccountData
    // This requires switchboard-on-demand types
    Err(OracleError::UnsupportedOracleType)
}
