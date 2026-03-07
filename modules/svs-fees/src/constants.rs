//! Fee module constants.

/// Basis points denominator (100% = 10000 bps).
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Seconds per year for annualized fee calculations.
pub const SECONDS_PER_YEAR: u64 = 31_536_000;

/// Maximum entry fee in basis points (10%).
pub const MAX_ENTRY_FEE_BPS: u16 = 1_000;

/// Maximum exit fee in basis points (10%).
pub const MAX_EXIT_FEE_BPS: u16 = 1_000;

/// Maximum management fee in basis points (5% annual).
pub const MAX_MANAGEMENT_FEE_BPS: u16 = 500;

/// Maximum performance fee in basis points (30%).
pub const MAX_PERFORMANCE_FEE_BPS: u16 = 3_000;

/// Scale factor for high water mark precision (1e9).
pub const HWM_SCALE: u64 = 1_000_000_000;
