//! Lock module constants.

/// Seconds per day.
pub const SECONDS_PER_DAY: i64 = 86_400;

/// Seconds per week.
pub const SECONDS_PER_WEEK: i64 = 604_800;

/// Seconds per year (365 days).
pub const SECONDS_PER_YEAR: i64 = 31_536_000;

/// Maximum lock duration: 1 year (prevents locking shares forever).
pub const MAX_LOCK_DURATION: i64 = SECONDS_PER_YEAR;

/// No lock (instant redemption).
pub const NO_LOCK: i64 = 0;
