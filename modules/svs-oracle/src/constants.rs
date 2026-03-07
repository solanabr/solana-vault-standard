//! Oracle module constants.

/// Price precision scale (1e9 - matches HWM_SCALE in svs-fees).
pub const PRICE_SCALE: u64 = 1_000_000_000;

/// Default maximum staleness: 1 hour.
pub const DEFAULT_MAX_STALENESS: i64 = 3600;

/// Minimum staleness allowed: 1 minute.
pub const MIN_STALENESS: i64 = 60;

/// Maximum staleness allowed: 24 hours.
pub const MAX_STALENESS: i64 = 86400;

/// Default maximum price deviation: 5% (500 bps).
pub const DEFAULT_MAX_DEVIATION_BPS: u16 = 500;

/// Basis points denominator.
pub const BPS_DENOMINATOR: u64 = 10_000;
