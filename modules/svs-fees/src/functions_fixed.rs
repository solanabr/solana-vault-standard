//! Fixed fee calculation functions (SVS-Fees compliance).

use crate::constants::{BPS_DENOMINATOR, HWM_SCALE, SECONDS_PER_YEAR};
use crate::error::FeeError;

/// FIXED: Apply entry fee with fair rounding (SVS-Fees compliance)
pub fn apply_entry_fee_fair(shares: u64, fee_bps: u16) -> Result<(u64, u64), FeeError> {
    if fee_bps == 0 || shares == 0 {
        return Ok((shares, 0));
    }

    // FIXED: Use floor rounding for user fairness (SVS-Fees compliance)
    let fee = svs_math::mul_div(
        shares,
        fee_bps as u64,
        BPS_DENOMINATOR,
        svs_math::Rounding::Floor,  // FIXED: Floor rounding favors user
    )?;

    let net = shares.checked_sub(fee).ok_or(FeeError::MathOverflow)?;

    Ok((net, fee))
}

/// FIXED: Apply exit fee with fair rounding (SVS-Fees compliance)
pub fn apply_exit_fee_fair(assets: u64, fee_bps: u16) -> Result<(u64, u64), FeeError> {
    if fee_bps == 0 || assets == 0 {
        return Ok((assets, 0));
    }

    // FIXED: Use floor rounding for user fairness (SVS-Fees compliance)
    let fee = svs_math::mul_div(
        assets,
        fee_bps as u64,
        BPS_DENOMINATOR,
        svs_math::Rounding::Floor,  // FIXED: Floor rounding favors user
    )?;

    let net = assets.checked_sub(fee).ok_or(FeeError::MathOverflow)?;

    Ok((net, fee))
}

/// FIXED: Context-aware fee calculation with configurable rounding
#[derive(Clone, Copy)]
pub enum FeeRoundingStrategy {
    UserFair,      // Floor rounding - favors user
    VaultFair,     // Ceiling rounding - favors vault
    Neutral,       // Round to nearest
}

/// FIXED: Apply entry fee with configurable rounding strategy
pub fn apply_entry_fee_context_aware(
    shares: u64,
    fee_bps: u16,
    strategy: FeeRoundingStrategy,
) -> Result<(u64, u64), FeeError> {
    if fee_bps == 0 || shares == 0 {
        return Ok((shares, 0));
    }

    let rounding = match strategy {
        FeeRoundingStrategy::UserFair => svs_math::Rounding::Floor,
        FeeRoundingStrategy::VaultFair => svs_math::Rounding::Ceiling,
        FeeRoundingStrategy::Neutral => svs_math::Rounding::Nearest,
    };

    let fee = svs_math::mul_div(
        shares,
        fee_bps as u64,
        BPS_DENOMINATOR,
        rounding,
    )?;

    let net = shares.checked_sub(fee).ok_or(FeeError::MathOverflow)?;

    Ok((net, fee))
}

/// FIXED: Apply exit fee with configurable rounding strategy
pub fn apply_exit_fee_context_aware(
    assets: u64,
    fee_bps: u16,
    strategy: FeeRoundingStrategy,
) -> Result<(u64, u64), FeeError> {
    if fee_bps == 0 || assets == 0 {
        return Ok((assets, 0));
    }

    let rounding = match strategy {
        FeeRoundingStrategy::UserFair => svs_math::Rounding::Floor,
        FeeRoundingStrategy::VaultFair => svs_math::Rounding::Ceiling,
        FeeRoundingStrategy::Neutral => svs_math::Rounding::Nearest,
    };

    let fee = svs_math::mul_div(
        assets,
        fee_bps as u64,
        BPS_DENOMINATOR,
        rounding,
    )?;

    let net = assets.checked_sub(fee).ok_or(FeeError::MathOverflow)?;

    Ok((net, fee))
}

/// FIXED: Calculate accrued management fee with fair rounding
pub fn accrue_management_fee_fair(
    total_assets: u64,
    fee_bps: u16,
    seconds_elapsed: i64,
) -> Result<u64, FeeError> {
    if total_assets == 0 || fee_bps == 0 || seconds_elapsed <= 0 {
        return Ok(0);
    }

    // FIXED: Use u128 for precision and floor rounding
    let fee = svs_math::mul_div(
        total_assets as u128,
        fee_bps as u128,
        (BPS_DENOMINATOR * SECONDS_PER_YEAR) as u128,
        svs_math::Rounding::Floor,  // FIXED: Floor rounding for user fairness
    )?;

    let time_adjusted_fee = fee
        .checked_mul(seconds_elapsed as u128)
        .ok_or(FeeError::MathOverflow)?
        .checked_div(SECONDS_PER_YEAR as u128)
        .ok_or(FeeError::MathOverflow)?;

    u64::try_from(time_adjusted_fee).map_err(|_| FeeError::MathOverflow)
}
