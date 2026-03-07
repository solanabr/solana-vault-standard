//! Core fee calculation functions.

use crate::constants::{BPS_DENOMINATOR, HWM_SCALE, SECONDS_PER_YEAR};
use crate::error::FeeError;

/// Apply entry fee to shares received from a deposit.
///
/// Fee is calculated with ceiling rounding to favor the vault.
///
/// # Arguments
/// * `shares` - Gross shares before fee
/// * `fee_bps` - Entry fee in basis points
///
/// # Returns
/// `(net_shares, fee_shares)` - Shares after fee and fee amount
///
/// # Example
/// ```
/// use svs_fees::apply_entry_fee;
///
/// // 1% entry fee on 1000 shares
/// let (net, fee) = apply_entry_fee(1000, 100).unwrap();
/// assert_eq!(fee, 10);  // 1% of 1000
/// assert_eq!(net, 990);
/// ```
pub fn apply_entry_fee(shares: u64, fee_bps: u16) -> Result<(u64, u64), FeeError> {
    if fee_bps == 0 || shares == 0 {
        return Ok((shares, 0));
    }

    // fee = shares * fee_bps / 10000 (ceiling)
    let fee = svs_math::mul_div(
        shares,
        fee_bps as u64,
        BPS_DENOMINATOR,
        svs_math::Rounding::Ceiling,
    )?;

    let net = shares.checked_sub(fee).ok_or(FeeError::MathOverflow)?;

    Ok((net, fee))
}

/// Apply exit fee to assets received from a withdrawal.
///
/// Fee is calculated with ceiling rounding to favor the vault.
///
/// # Arguments
/// * `assets` - Gross assets before fee
/// * `fee_bps` - Exit fee in basis points
///
/// # Returns
/// `(net_assets, fee_assets)` - Assets after fee and fee amount
///
/// # Example
/// ```
/// use svs_fees::apply_exit_fee;
///
/// // 0.5% exit fee on 10000 assets
/// let (net, fee) = apply_exit_fee(10000, 50).unwrap();
/// assert_eq!(fee, 50);  // 0.5% of 10000
/// assert_eq!(net, 9950);
/// ```
pub fn apply_exit_fee(assets: u64, fee_bps: u16) -> Result<(u64, u64), FeeError> {
    if fee_bps == 0 || assets == 0 {
        return Ok((assets, 0));
    }

    // fee = assets * fee_bps / 10000 (ceiling)
    let fee = svs_math::mul_div(
        assets,
        fee_bps as u64,
        BPS_DENOMINATOR,
        svs_math::Rounding::Ceiling,
    )?;

    let net = assets.checked_sub(fee).ok_or(FeeError::MathOverflow)?;

    Ok((net, fee))
}

/// Calculate accrued management fee for a time period.
///
/// Management fee is charged as a percentage of AUM pro-rated over time.
/// Formula: total_assets * fee_bps * seconds_elapsed / (BPS_DENOMINATOR * SECONDS_PER_YEAR)
///
/// # Arguments
/// * `total_assets` - Current total assets under management
/// * `fee_bps` - Annual management fee in basis points
/// * `seconds_elapsed` - Time since last fee collection
///
/// # Returns
/// Fee amount in assets
///
/// # Example
/// ```
/// use svs_fees::accrue_management_fee;
///
/// // 2% annual fee on 1M assets for 30 days
/// let fee = accrue_management_fee(1_000_000, 200, 30 * 86400).unwrap();
/// // Expected: 1M * 200/10000 * (30*86400)/31536000 ≈ 1644
/// assert!(fee > 1600 && fee < 1700);
/// ```
pub fn accrue_management_fee(
    total_assets: u64,
    fee_bps: u16,
    seconds_elapsed: i64,
) -> Result<u64, FeeError> {
    if fee_bps == 0 || seconds_elapsed <= 0 || total_assets == 0 {
        return Ok(0);
    }

    let seconds = seconds_elapsed as u64;

    // Use u128 intermediate to prevent overflow:
    // fee = total_assets * fee_bps * seconds / (BPS_DENOMINATOR * SECONDS_PER_YEAR)
    let numerator = (total_assets as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(FeeError::MathOverflow)?
        .checked_mul(seconds as u128)
        .ok_or(FeeError::MathOverflow)?;

    let denominator = (BPS_DENOMINATOR as u128)
        .checked_mul(SECONDS_PER_YEAR as u128)
        .ok_or(FeeError::MathOverflow)?;

    let fee = numerator / denominator;

    if fee > u64::MAX as u128 {
        return Err(FeeError::MathOverflow);
    }

    Ok(fee as u64)
}

/// Calculate performance fee based on high water mark.
///
/// Performance fee is only charged when the current NAV per share exceeds
/// the previous high water mark. The fee is taken on the profit above HWM.
///
/// # Arguments
/// * `current_nav` - Current NAV per share (scaled by HWM_SCALE = 1e9)
/// * `high_water_mark` - Previous high water mark (scaled by HWM_SCALE)
/// * `total_shares` - Total shares outstanding
/// * `fee_bps` - Performance fee in basis points
///
/// # Returns
/// `(fee_shares, new_high_water_mark)` - Fee in shares and updated HWM
///
/// # Example
/// ```
/// use svs_fees::{accrue_performance_fee, HWM_SCALE};
///
/// // 20% performance fee, NAV increased from 1.0 to 1.1
/// let hwm = HWM_SCALE;              // 1.0
/// let nav = HWM_SCALE + HWM_SCALE / 10; // 1.1
/// let (fee, new_hwm) = accrue_performance_fee(nav, hwm, 1_000_000, 2000).unwrap();
/// // Profit: 10% of 1M = 100k, fee: 20% of 100k = 20k shares
/// assert!(fee > 19_000 && fee < 21_000);
/// assert_eq!(new_hwm, nav);
/// ```
pub fn accrue_performance_fee(
    current_nav: u64,
    high_water_mark: u64,
    total_shares: u64,
    fee_bps: u16,
) -> Result<(u64, u64), FeeError> {
    // No fee if no shares, no fee rate, or NAV hasn't exceeded HWM
    if fee_bps == 0 || total_shares == 0 || current_nav <= high_water_mark {
        return Ok((0, high_water_mark));
    }

    // profit_per_share = current_nav - hwm
    let profit_per_share = current_nav
        .checked_sub(high_water_mark)
        .ok_or(FeeError::MathOverflow)?;

    // total_profit = profit_per_share * total_shares / HWM_SCALE
    let total_profit = svs_math::mul_div(
        profit_per_share,
        total_shares,
        HWM_SCALE,
        svs_math::Rounding::Floor,
    )?;

    // fee = total_profit * fee_bps / BPS_DENOMINATOR
    let fee_shares = svs_math::mul_div(
        total_profit,
        fee_bps as u64,
        BPS_DENOMINATOR,
        svs_math::Rounding::Floor,
    )?;

    Ok((fee_shares, current_nav))
}

/// Calculate current NAV per share (scaled by HWM_SCALE).
///
/// # Arguments
/// * `total_assets` - Total assets in vault
/// * `total_shares` - Total shares outstanding
///
/// # Returns
/// NAV per share scaled by 1e9
pub fn calculate_nav_per_share(total_assets: u64, total_shares: u64) -> Result<u64, FeeError> {
    if total_shares == 0 {
        return Ok(HWM_SCALE); // 1.0 when no shares
    }

    svs_math::mul_div(
        total_assets,
        HWM_SCALE,
        total_shares,
        svs_math::Rounding::Floor,
    )
    .map_err(|_| FeeError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_entry_fee() {
        // 1% fee on 1000 shares
        let (net, fee) = apply_entry_fee(1000, 100).unwrap();
        assert_eq!(fee, 10);
        assert_eq!(net, 990);
    }

    #[test]
    fn test_apply_entry_fee_zero() {
        let (net, fee) = apply_entry_fee(1000, 0).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(net, 1000);
    }

    #[test]
    fn test_apply_entry_fee_ceiling() {
        // 1 bps on 99 = 0.99 -> ceiling = 1
        let (net, fee) = apply_entry_fee(99, 1).unwrap();
        assert_eq!(fee, 1);
        assert_eq!(net, 98);
    }

    #[test]
    fn test_apply_exit_fee() {
        // 0.5% fee on 10000 assets
        let (net, fee) = apply_exit_fee(10000, 50).unwrap();
        assert_eq!(fee, 50);
        assert_eq!(net, 9950);
    }

    #[test]
    fn test_apply_exit_fee_zero_assets() {
        let (net, fee) = apply_exit_fee(0, 100).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(net, 0);
    }

    #[test]
    fn test_accrue_management_fee() {
        // 2% annual fee on 1M assets for 365 days
        let fee = accrue_management_fee(1_000_000, 200, SECONDS_PER_YEAR as i64).unwrap();
        // Should be exactly 2% = 20000
        assert_eq!(fee, 20000);
    }

    #[test]
    fn test_accrue_management_fee_30_days() {
        // 2% annual fee on 1M assets for 30 days
        let fee = accrue_management_fee(1_000_000, 200, 30 * 86400).unwrap();
        // 1M * 0.02 * (30/365) ≈ 1644
        assert!(fee > 1600 && fee < 1700);
    }

    #[test]
    fn test_accrue_management_fee_zero() {
        assert_eq!(accrue_management_fee(1_000_000, 0, 86400).unwrap(), 0);
        assert_eq!(accrue_management_fee(0, 200, 86400).unwrap(), 0);
        assert_eq!(accrue_management_fee(1_000_000, 200, 0).unwrap(), 0);
        assert_eq!(accrue_management_fee(1_000_000, 200, -100).unwrap(), 0);
    }

    #[test]
    fn test_accrue_performance_fee() {
        // 20% performance fee
        // NAV increased from 1.0 to 1.1 (10% profit)
        let hwm = HWM_SCALE;
        let nav = HWM_SCALE + HWM_SCALE / 10; // 1.1

        let (fee, new_hwm) = accrue_performance_fee(nav, hwm, 1_000_000, 2000).unwrap();

        // Profit: 10% of 1M shares at HWM_SCALE = 100,000 "profit units"
        // Fee: 20% of profit = 20,000 shares
        assert_eq!(fee, 20000);
        assert_eq!(new_hwm, nav);
    }

    #[test]
    fn test_accrue_performance_fee_no_profit() {
        let hwm = HWM_SCALE;
        let nav = HWM_SCALE; // No change

        let (fee, new_hwm) = accrue_performance_fee(nav, hwm, 1_000_000, 2000).unwrap();

        assert_eq!(fee, 0);
        assert_eq!(new_hwm, hwm);
    }

    #[test]
    fn test_accrue_performance_fee_below_hwm() {
        let hwm = HWM_SCALE;
        let nav = HWM_SCALE - HWM_SCALE / 10; // 0.9 (loss)

        let (fee, new_hwm) = accrue_performance_fee(nav, hwm, 1_000_000, 2000).unwrap();

        assert_eq!(fee, 0);
        assert_eq!(new_hwm, hwm); // HWM stays the same
    }

    #[test]
    fn test_calculate_nav_per_share() {
        // 1M assets, 1M shares = 1.0 NAV
        let nav = calculate_nav_per_share(1_000_000, 1_000_000).unwrap();
        assert_eq!(nav, HWM_SCALE);

        // 1.5M assets, 1M shares = 1.5 NAV
        let nav = calculate_nav_per_share(1_500_000, 1_000_000).unwrap();
        assert_eq!(nav, HWM_SCALE + HWM_SCALE / 2);

        // Empty vault = 1.0 NAV
        let nav = calculate_nav_per_share(0, 0).unwrap();
        assert_eq!(nav, HWM_SCALE);
    }
}
