//! Math module wrapper - re-exports from svs-math with Anchor error conversion.

use anchor_lang::prelude::*;

use crate::error::VaultError;

// Re-export types from svs-math
pub use svs_math::Rounding;

/// Convert assets to shares with virtual offset protection against inflation attacks.
///
/// Wraps svs_math::convert_to_shares with Anchor error conversion.
pub fn convert_to_shares(
    assets: u64,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64> {
    svs_math::convert_to_shares(
        assets,
        total_assets,
        total_shares,
        decimals_offset,
        rounding,
    )
    .map_err(|e| match e {
        svs_math::MathError::Overflow => VaultError::MathOverflow.into(),
        svs_math::MathError::DivisionByZero => VaultError::DivisionByZero.into(),
    })
}

/// Convert shares to assets with virtual offset protection.
///
/// Wraps svs_math::convert_to_assets with Anchor error conversion.
pub fn convert_to_assets(
    shares: u64,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64> {
    svs_math::convert_to_assets(
        shares,
        total_assets,
        total_shares,
        decimals_offset,
        rounding,
    )
    .map_err(|e| match e {
        svs_math::MathError::Overflow => VaultError::MathOverflow.into(),
        svs_math::MathError::DivisionByZero => VaultError::DivisionByZero.into(),
    })
}

/// Safe multiplication then division with configurable rounding.
///
/// Wraps svs_math::mul_div with Anchor error conversion.
pub fn mul_div(value: u64, numerator: u64, denominator: u64, rounding: Rounding) -> Result<u64> {
    svs_math::mul_div(value, numerator, denominator, rounding).map_err(|e| match e {
        svs_math::MathError::Overflow => VaultError::MathOverflow.into(),
        svs_math::MathError::DivisionByZero => VaultError::DivisionByZero.into(),
    })
}
