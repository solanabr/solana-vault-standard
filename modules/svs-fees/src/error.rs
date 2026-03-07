//! Fee module error types.

/// Errors that can occur during fee operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeError {
    /// Entry fee exceeds maximum allowed (10%).
    EntryFeeExceedsMax,
    /// Exit fee exceeds maximum allowed (10%).
    ExitFeeExceedsMax,
    /// Management fee exceeds maximum allowed (5%).
    ManagementFeeExceedsMax,
    /// Performance fee exceeds maximum allowed (30%).
    PerformanceFeeExceedsMax,
    /// Arithmetic overflow during fee calculation.
    MathOverflow,
}

impl core::fmt::Display for FeeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            FeeError::EntryFeeExceedsMax => write!(f, "entry fee exceeds maximum 1000 bps (10%)"),
            FeeError::ExitFeeExceedsMax => write!(f, "exit fee exceeds maximum 1000 bps (10%)"),
            FeeError::ManagementFeeExceedsMax => {
                write!(f, "management fee exceeds maximum 500 bps (5%)")
            }
            FeeError::PerformanceFeeExceedsMax => {
                write!(f, "performance fee exceeds maximum 3000 bps (30%)")
            }
            FeeError::MathOverflow => write!(f, "arithmetic overflow in fee calculation"),
        }
    }
}

impl std::error::Error for FeeError {}

impl From<svs_math::MathError> for FeeError {
    fn from(_: svs_math::MathError) -> Self {
        FeeError::MathOverflow
    }
}
