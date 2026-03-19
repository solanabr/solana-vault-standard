//! Math module wrapper - re-exports from svs-math with Anchor error conversion.

use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::NativeSolStreamVault;

pub use svs_math::Rounding;

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

pub fn mul_div(value: u64, numerator: u64, denominator: u64, rounding: Rounding) -> Result<u64> {
    svs_math::mul_div(value, numerator, denominator, rounding).map_err(|e| match e {
        svs_math::MathError::Overflow => VaultError::MathOverflow.into(),
        svs_math::MathError::DivisionByZero => VaultError::DivisionByZero.into(),
    })
}

pub fn effective_total_assets(vault: &NativeSolStreamVault, now: i64) -> Result<u64> {
    if now >= vault.stream_end || vault.stream_start >= vault.stream_end {
        return vault
            .base_assets
            .checked_add(vault.stream_amount)
            .ok_or(VaultError::MathOverflow.into());
    }

    if now <= vault.stream_start {
        return Ok(vault.base_assets);
    }

    let elapsed = (now - vault.stream_start) as u64;
    let duration = (vault.stream_end - vault.stream_start) as u64;
    let accrued = mul_div(vault.stream_amount, elapsed, duration, Rounding::Floor)?;

    vault
        .base_assets
        .checked_add(accrued)
        .ok_or(VaultError::MathOverflow.into())
}

/// Finalize all currently accrued stream yield into base assets.
/// Returns `(accrued, effective_total_assets_after_checkpoint)`.
pub fn checkpoint_stream(vault: &mut NativeSolStreamVault, now: i64) -> Result<(u64, u64)> {
    let previous_base = vault.base_assets;
    let effective = effective_total_assets(vault, now)?;
    let accrued = effective
        .checked_sub(previous_base)
        .ok_or(VaultError::MathOverflow)?;

    vault.base_assets = effective;

    if now >= vault.stream_end || vault.stream_start >= vault.stream_end {
        vault.stream_amount = 0;
        vault.stream_start = now;
        vault.stream_end = now;
    } else {
        vault.stream_amount = vault
            .stream_amount
            .checked_sub(accrued)
            .ok_or(VaultError::MathOverflow)?;
        vault.stream_start = now;
    }

    vault.last_checkpoint = now;
    Ok((accrued, effective))
}
