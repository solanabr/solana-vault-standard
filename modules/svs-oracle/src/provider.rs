//! Oracle provider types and unified price reading interface.

use crate::error::OracleError;

/// Oracle provider type discriminant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum OracleType {
    Pyth = 0,
    Switchboard = 1,
    Custom = 2,
}

impl TryFrom<u8> for OracleType {
    type Error = OracleError;
    fn try_from(value: u8) -> Result<Self, OracleError> {
        match value {
            0 => Ok(OracleType::Pyth),
            1 => Ok(OracleType::Switchboard),
            2 => Ok(OracleType::Custom),
            _ => Err(OracleError::UnsupportedOracleType),
        }
    }
}

/// Normalized price output from any oracle provider.
#[derive(Debug, PartialEq, Eq)]
pub struct NormalizedPrice {
    pub price: u64,
    pub confidence: u64,
    pub updated_at: i64,
}

/// Read and normalize a price from oracle account data.
///
/// Dispatches to the appropriate provider based on `oracle_type`.
/// Validates freshness against `max_staleness` and `current_timestamp`.
pub fn read_oracle_price(
    data: &[u8],
    oracle_type: OracleType,
    max_staleness: i64,
    current_timestamp: i64,
) -> Result<NormalizedPrice, OracleError> {
    let normalized: NormalizedPrice = match oracle_type {
        #[cfg(feature = "pyth")]
        OracleType::Pyth => crate::providers::pyth::read_price(data)?,
        #[cfg(not(feature = "pyth"))]
        OracleType::Pyth => return Err(OracleError::UnsupportedOracleType),

        #[cfg(feature = "switchboard")]
        OracleType::Switchboard => crate::providers::switchboard::read_price(data)?,
        #[cfg(not(feature = "switchboard"))]
        OracleType::Switchboard => return Err(OracleError::UnsupportedOracleType),

        #[cfg(feature = "custom")]
        OracleType::Custom => crate::providers::custom::read_price(data)?,
        #[cfg(not(feature = "custom"))]
        OracleType::Custom => return Err(OracleError::UnsupportedOracleType),
    };

    crate::validate_price(normalized.price)?;
    crate::validate_freshness(normalized.updated_at, current_timestamp, max_staleness)?;

    Ok(normalized)
}
