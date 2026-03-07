//! Math error types for SVS vault operations.

/// Errors that can occur during mathematical operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    /// Arithmetic overflow occurred during calculation.
    Overflow,
    /// Division by zero attempted.
    DivisionByZero,
}

impl core::fmt::Display for MathError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            MathError::Overflow => write!(f, "arithmetic overflow"),
            MathError::DivisionByZero => write!(f, "division by zero"),
        }
    }
}

impl std::error::Error for MathError {}
