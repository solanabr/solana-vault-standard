//! Reward module constants.

/// Precision scale for accumulated rewards per share (1e18).
/// Using u128 for high precision in accumulated_per_share calculations.
pub const REWARD_PRECISION: u128 = 1_000_000_000_000_000_000; // 1e18

/// Maximum number of reward tokens per vault.
pub const MAX_REWARD_TOKENS: usize = 5;
