//! Reward module error types.

/// Errors that can occur during reward operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewardError {
    /// No rewards available to claim.
    NothingToClaim,
    /// Arithmetic overflow during reward calculation.
    MathOverflow,
    /// Division by zero in reward calculation.
    DivisionByZero,
    /// Insufficient reward balance.
    InsufficientRewardBalance,
}

impl core::fmt::Display for RewardError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            RewardError::NothingToClaim => write!(f, "no rewards available to claim"),
            RewardError::MathOverflow => write!(f, "arithmetic overflow in reward calculation"),
            RewardError::DivisionByZero => write!(f, "division by zero in reward calculation"),
            RewardError::InsufficientRewardBalance => write!(f, "insufficient reward balance"),
        }
    }
}

impl std::error::Error for RewardError {}
