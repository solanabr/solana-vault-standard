use anchor_lang::prelude::*;
use crate::error::VaultError;

// Re-export shared math from svs-math crate
pub use svs_math::{convert_to_assets, convert_to_shares, mul_div, Rounding};

/// Calculate the accrued yield from a stream at a given timestamp.
///
/// Returns the amount of yield that has accrued since stream_start.
/// Caps at stream_amount when past stream_end.
///
/// Formula: accrued = stream_amount * min(elapsed, duration) / duration
pub fn calculate_accrued(
    stream_amount: u64,
    stream_start: i64,
    stream_end: i64,
    current_timestamp: i64,
) -> Result<u64> {
    if stream_amount == 0 || stream_end <= stream_start {
        return Ok(0);
    }

    let duration = (stream_end
        .checked_sub(stream_start)
        .ok_or(VaultError::MathOverflow)?) as u128;

    let elapsed = (current_timestamp
        .checked_sub(stream_start)
        .ok_or(VaultError::MathOverflow)?)
    .max(0) as u128;

    let capped_elapsed = elapsed.min(duration);

    let accrued = (stream_amount as u128)
        .checked_mul(capped_elapsed)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(duration)
        .ok_or(VaultError::DivisionByZero)? as u64;

    Ok(accrued)
}

/// Perform a checkpoint calculation: settle accrued yield into base_assets
/// and return the new (base_assets, remaining_stream_amount).
///
/// After checkpoint:
///   new_base_assets = old_base_assets + accrued
///   new_stream_amount = old_stream_amount - accrued
pub fn calculate_checkpoint(
    base_assets: u64,
    stream_amount: u64,
    stream_start: i64,
    stream_end: i64,
    current_timestamp: i64,
) -> Result<(u64, u64)> {
    let accrued = calculate_accrued(stream_amount, stream_start, stream_end, current_timestamp)?;

    let new_base = base_assets
        .checked_add(accrued)
        .ok_or(VaultError::MathOverflow)?;

    let new_stream = stream_amount
        .checked_sub(accrued)
        .ok_or(VaultError::MathOverflow)?;

    Ok((new_base, new_stream))
}

/// Calculate decimals_offset from asset decimals.
/// offset = 9 - asset_decimals
/// Used for inflation attack protection: virtual_shares = 10^offset
pub fn calculate_decimals_offset(asset_decimals: u8) -> Result<u8> {
    require!(asset_decimals <= 9, VaultError::InvalidAssetDecimals);
    Ok(9 - asset_decimals)
}
