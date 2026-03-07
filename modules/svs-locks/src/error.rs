//! Lock module error types.

/// Errors that can occur during lock enforcement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockError {
    /// Shares are still locked and cannot be redeemed.
    SharesLocked,
    /// Lock duration exceeds maximum allowed.
    DurationExceedsMax,
    /// Lock duration is invalid (e.g., negative).
    InvalidDuration,
    /// Arithmetic overflow during lock calculation.
    MathOverflow,
}

impl core::fmt::Display for LockError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            LockError::SharesLocked => write!(f, "shares are still locked"),
            LockError::DurationExceedsMax => write!(f, "lock duration exceeds maximum"),
            LockError::InvalidDuration => write!(f, "invalid lock duration"),
            LockError::MathOverflow => write!(f, "arithmetic overflow in lock calculation"),
        }
    }
}

impl std::error::Error for LockError {}
