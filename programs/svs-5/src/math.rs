//! Math module: re-exports from svs-math with Anchor error conversion,
//! plus SVS-5's core `effective_total_assets` streaming computation.

use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::StreamVault;

// Re-export types from svs-math
pub use svs_math::Rounding;

/// Compute effective total_assets at a given timestamp.
///
/// This replaces direct reads of `asset_vault.amount` used in SVS-1.
/// Total assets increase linearly from `base_assets` toward
/// `base_assets + stream_amount` over [stream_start, stream_end].
///
/// Edge cases:
/// - No active stream (stream_amount == 0 or stream_start >= stream_end):
///   returns base_assets + stream_amount (i.e. base_assets, since stream_amount is 0)
/// - Stream complete (now >= stream_end): returns base_assets + stream_amount (full accrual)
/// - Before stream start (now <= stream_start): returns base_assets (no accrual yet)
/// - Mid-stream: interpolates linearly via mul_div
pub fn effective_total_assets(vault: &StreamVault, now: i64) -> Result<u64> {
    // Stream complete or no active stream (stream_start >= stream_end means idle)
    if now >= vault.stream_end || vault.stream_start >= vault.stream_end {
        return vault
            .base_assets
            .checked_add(vault.stream_amount)
            .ok_or_else(|| error!(VaultError::MathOverflow));
    }

    // Before stream starts — no yield has accrued yet
    if now <= vault.stream_start {
        return Ok(vault.base_assets);
    }

    // Mid-stream: linearly interpolate
    let elapsed = (now - vault.stream_start) as u64;
    let duration = (vault.stream_end - vault.stream_start) as u64;
    let accrued = mul_div(vault.stream_amount, elapsed, duration, Rounding::Floor)?;

    vault
        .base_assets
        .checked_add(accrued)
        .ok_or_else(|| error!(VaultError::MathOverflow))
}

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
