//! Cap module error types.

/// Errors that can occur during cap enforcement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapError {
    /// Deposit would exceed the global vault cap.
    GlobalCapExceeded,
    /// Deposit would exceed the per-user cap.
    UserCapExceeded,
    /// Per-user cap exceeds global cap (invalid config).
    UserCapExceedsGlobalCap,
    /// Arithmetic overflow during cap calculation.
    MathOverflow,
}

impl core::fmt::Display for CapError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CapError::GlobalCapExceeded => write!(f, "deposit would exceed global vault cap"),
            CapError::UserCapExceeded => write!(f, "deposit would exceed per-user cap"),
            CapError::UserCapExceedsGlobalCap => {
                write!(f, "per-user cap cannot exceed global cap")
            }
            CapError::MathOverflow => write!(f, "arithmetic overflow in cap calculation"),
        }
    }
}

impl std::error::Error for CapError {}

impl From<svs_math::MathError> for CapError {
    fn from(_: svs_math::MathError) -> Self {
        CapError::MathOverflow
    }
}
