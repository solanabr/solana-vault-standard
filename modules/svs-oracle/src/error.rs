//! Oracle module error types.

/// Errors that can occur during oracle validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OracleError {
    /// Oracle price is stale (too old).
    StalePrice,
    /// Oracle price is zero or invalid.
    InvalidPrice,
    /// Oracle update authority mismatch.
    UnauthorizedUpdate,
    /// Price deviation exceeds maximum allowed.
    PriceDeviationExceeded,
    /// Arithmetic overflow in price calculation.
    MathOverflow,
}

impl core::fmt::Display for OracleError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            OracleError::StalePrice => write!(f, "oracle price is stale"),
            OracleError::InvalidPrice => write!(f, "oracle price is invalid"),
            OracleError::UnauthorizedUpdate => write!(f, "unauthorized oracle update"),
            OracleError::PriceDeviationExceeded => write!(f, "price deviation exceeds maximum"),
            OracleError::MathOverflow => write!(f, "arithmetic overflow in price calculation"),
        }
    }
}

impl std::error::Error for OracleError {}
