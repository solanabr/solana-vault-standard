//! Core oracle validation functions.

use crate::constants::{BPS_DENOMINATOR, MAX_STALENESS, MIN_STALENESS, PRICE_SCALE};
use crate::error::OracleError;

/// Validate oracle price freshness.
///
/// # Arguments
/// * `updated_at` - Timestamp when price was last updated
/// * `current_timestamp` - Current Unix timestamp
/// * `max_staleness` - Maximum allowed age in seconds
///
/// # Returns
/// Ok(()) if price is fresh, Err(StalePrice) otherwise
///
/// # Example
/// ```
/// use svs_oracle::validate_freshness;
///
/// // Price updated 10 minutes ago, max staleness 1 hour
/// assert!(validate_freshness(1000, 1600, 3600).is_ok());
///
/// // Price updated 2 hours ago, max staleness 1 hour
/// assert!(validate_freshness(1000, 8200, 3600).is_err());
/// ```
pub fn validate_freshness(
    updated_at: i64,
    current_timestamp: i64,
    max_staleness: i64,
) -> Result<(), OracleError> {
    let age = current_timestamp.saturating_sub(updated_at);

    if age > max_staleness {
        return Err(OracleError::StalePrice);
    }

    Ok(())
}

/// Validate oracle price is non-zero.
///
/// # Arguments
/// * `price` - Oracle price (scaled by PRICE_SCALE)
///
/// # Returns
/// Ok(()) if price is valid, Err(InvalidPrice) otherwise
pub fn validate_price(price: u64) -> Result<(), OracleError> {
    if price == 0 {
        return Err(OracleError::InvalidPrice);
    }
    Ok(())
}

/// Validate price deviation from expected value.
///
/// Used to ensure oracle price hasn't deviated too far from computed value.
///
/// # Arguments
/// * `oracle_price` - Price from oracle
/// * `expected_price` - Expected/computed price
/// * `max_deviation_bps` - Maximum allowed deviation in basis points
///
/// # Returns
/// Ok(()) if within tolerance, Err(PriceDeviationExceeded) otherwise
///
/// # Example
/// ```
/// use svs_oracle::validate_deviation;
///
/// // Oracle: 1.05, Expected: 1.00, Max deviation: 10% -> OK
/// assert!(validate_deviation(1_050_000_000, 1_000_000_000, 1000).is_ok());
///
/// // Oracle: 1.15, Expected: 1.00, Max deviation: 10% -> Fail
/// assert!(validate_deviation(1_150_000_000, 1_000_000_000, 1000).is_err());
/// ```
pub fn validate_deviation(
    oracle_price: u64,
    expected_price: u64,
    max_deviation_bps: u16,
) -> Result<(), OracleError> {
    if expected_price == 0 {
        return if oracle_price == 0 {
            Ok(())
        } else {
            Err(OracleError::PriceDeviationExceeded)
        };
    }

    // Calculate deviation: |oracle - expected| * BPS / expected
    let diff = if oracle_price > expected_price {
        oracle_price - expected_price
    } else {
        expected_price - oracle_price
    };

    let deviation_bps = (diff as u128)
        .checked_mul(BPS_DENOMINATOR as u128)
        .ok_or(OracleError::MathOverflow)?
        .checked_div(expected_price as u128)
        .ok_or(OracleError::MathOverflow)?;

    if deviation_bps > max_deviation_bps as u128 {
        return Err(OracleError::PriceDeviationExceeded);
    }

    Ok(())
}

/// Full oracle validation.
///
/// # Arguments
/// * `price` - Oracle price (scaled by PRICE_SCALE)
/// * `updated_at` - Timestamp when price was last updated
/// * `current_timestamp` - Current Unix timestamp
/// * `max_staleness` - Maximum allowed age in seconds
///
/// # Returns
/// Ok(()) if oracle is valid
pub fn validate_oracle(
    price: u64,
    updated_at: i64,
    current_timestamp: i64,
    max_staleness: i64,
) -> Result<(), OracleError> {
    validate_price(price)?;
    validate_freshness(updated_at, current_timestamp, max_staleness)?;
    Ok(())
}

/// Validate staleness configuration.
///
/// # Arguments
/// * `max_staleness` - Proposed maximum staleness in seconds
///
/// # Returns
/// Ok(()) if valid
pub fn validate_staleness_config(max_staleness: i64) -> Result<(), OracleError> {
    if max_staleness < MIN_STALENESS || max_staleness > MAX_STALENESS {
        return Err(OracleError::InvalidPrice);
    }
    Ok(())
}

/// Calculate time until price becomes stale.
///
/// # Arguments
/// * `updated_at` - Timestamp when price was last updated
/// * `current_timestamp` - Current Unix timestamp
/// * `max_staleness` - Maximum allowed age in seconds
///
/// # Returns
/// Seconds until stale (0 if already stale)
pub fn time_until_stale(updated_at: i64, current_timestamp: i64, max_staleness: i64) -> i64 {
    let age = current_timestamp.saturating_sub(updated_at);
    (max_staleness - age).max(0)
}

/// Convert assets to shares using oracle price.
///
/// # Arguments
/// * `assets` - Asset amount to convert
/// * `price_per_share` - Oracle price (assets per share, scaled by PRICE_SCALE)
///
/// # Returns
/// Shares amount (rounded down to favor vault)
pub fn assets_to_shares(assets: u64, price_per_share: u64) -> Result<u64, OracleError> {
    if price_per_share == 0 {
        return Err(OracleError::InvalidPrice);
    }

    // shares = assets * PRICE_SCALE / price_per_share
    let shares = (assets as u128)
        .checked_mul(PRICE_SCALE as u128)
        .ok_or(OracleError::MathOverflow)?
        .checked_div(price_per_share as u128)
        .ok_or(OracleError::MathOverflow)?;

    if shares > u64::MAX as u128 {
        return Err(OracleError::MathOverflow);
    }

    Ok(shares as u64)
}

/// Convert shares to assets using oracle price.
///
/// # Arguments
/// * `shares` - Share amount to convert
/// * `price_per_share` - Oracle price (assets per share, scaled by PRICE_SCALE)
///
/// # Returns
/// Assets amount (rounded down to favor vault)
pub fn shares_to_assets(shares: u64, price_per_share: u64) -> Result<u64, OracleError> {
    // assets = shares * price_per_share / PRICE_SCALE
    let assets = (shares as u128)
        .checked_mul(price_per_share as u128)
        .ok_or(OracleError::MathOverflow)?
        .checked_div(PRICE_SCALE as u128)
        .ok_or(OracleError::MathOverflow)?;

    if assets > u64::MAX as u128 {
        return Err(OracleError::MathOverflow);
    }

    Ok(assets as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_freshness_ok() {
        // 10 minutes old, 1 hour max
        assert!(validate_freshness(1000, 1600, 3600).is_ok());
    }

    #[test]
    fn test_validate_freshness_stale() {
        // 2 hours old, 1 hour max
        assert_eq!(
            validate_freshness(1000, 8200, 3600),
            Err(OracleError::StalePrice)
        );
    }

    #[test]
    fn test_validate_freshness_exact() {
        // Exactly at max staleness - still valid
        assert!(validate_freshness(1000, 4600, 3600).is_ok());
    }

    #[test]
    fn test_validate_price() {
        assert!(validate_price(PRICE_SCALE).is_ok());
        assert!(validate_price(1).is_ok());
        assert_eq!(validate_price(0), Err(OracleError::InvalidPrice));
    }

    #[test]
    fn test_validate_deviation_ok() {
        // 5% deviation, 10% max
        assert!(validate_deviation(1_050_000_000, 1_000_000_000, 1000).is_ok());
    }

    #[test]
    fn test_validate_deviation_exceeded() {
        // 15% deviation, 10% max
        assert_eq!(
            validate_deviation(1_150_000_000, 1_000_000_000, 1000),
            Err(OracleError::PriceDeviationExceeded)
        );
    }

    #[test]
    fn test_validate_deviation_negative() {
        // -5% deviation, 10% max
        assert!(validate_deviation(950_000_000, 1_000_000_000, 1000).is_ok());
    }

    #[test]
    fn test_validate_oracle() {
        assert!(validate_oracle(PRICE_SCALE, 1000, 1600, 3600).is_ok());
        assert_eq!(
            validate_oracle(0, 1000, 1600, 3600),
            Err(OracleError::InvalidPrice)
        );
        assert_eq!(
            validate_oracle(PRICE_SCALE, 1000, 8200, 3600),
            Err(OracleError::StalePrice)
        );
    }

    #[test]
    fn test_time_until_stale() {
        // 10 minutes old, 1 hour max -> 50 minutes left
        assert_eq!(time_until_stale(1000, 1600, 3600), 3000);

        // Already stale
        assert_eq!(time_until_stale(1000, 8200, 3600), 0);
    }

    #[test]
    fn test_assets_to_shares() {
        // 1:1 price
        assert_eq!(assets_to_shares(1000, PRICE_SCALE).unwrap(), 1000);

        // 2:1 price (2 assets per share)
        assert_eq!(assets_to_shares(2000, 2 * PRICE_SCALE).unwrap(), 1000);

        // 0.5:1 price (0.5 assets per share)
        assert_eq!(assets_to_shares(500, PRICE_SCALE / 2).unwrap(), 1000);
    }

    #[test]
    fn test_shares_to_assets() {
        // 1:1 price
        assert_eq!(shares_to_assets(1000, PRICE_SCALE).unwrap(), 1000);

        // 2:1 price
        assert_eq!(shares_to_assets(1000, 2 * PRICE_SCALE).unwrap(), 2000);

        // 0.5:1 price
        assert_eq!(shares_to_assets(1000, PRICE_SCALE / 2).unwrap(), 500);
    }

    #[test]
    fn test_roundtrip() {
        let price = PRICE_SCALE + PRICE_SCALE / 10; // 1.1
        let assets = 1_000_000u64;

        let shares = assets_to_shares(assets, price).unwrap();
        let back = shares_to_assets(shares, price).unwrap();

        // Should round down, so back <= original
        assert!(back <= assets);
    }
}
