use anchor_lang::prelude::*;
use crate::error::VaultError;

/// Calculates the number of shares to issue for a given amount of assets.
///
/// Formula: (assets × (total_shares + virtual_offset)) / (total_assets + virtual_offset)
///
/// `virtual_offset = 10^decimals_offset` acts as a "dead shares" seed that:
///   1. Prevents the first-depositor inflation attack (minting dust shares).
///   2. Maintains the round-trip invariant: to_shares(to_assets(x, S, A, d), S, A, d) ≈ x.
///
/// Both numerator and denominator use the same `virtual_offset` so the exchange rate
/// is 1:1 on an empty vault regardless of `decimals_offset`.
///
/// Rounding: Floor (favors the vault).
pub fn calculate_shares(assets: u64, total_assets: u64, total_shares: u64, decimals_offset: u8) -> Result<u64> {
    let virtual_offset = 10u128.pow(decimals_offset as u32);

    let result = (assets as u128)
        .checked_mul(total_shares as u128 + virtual_offset)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(total_assets as u128 + 1)
        .ok_or(VaultError::DivisionByZero)?;

    u64::try_from(result).map_err(|_| VaultError::MathOverflow.into())
}

/// Calculates the number of assets to return for a given amount of shares.
///
/// Formula: (shares × (total_assets + 1)) / (total_shares + virtual_offset)
///
/// Uses the same `virtual_offset = 10^decimals_offset` as `calculate_shares` to keep
/// the conversion symmetric and maintain the round-trip invariant.
///
/// Rounding: Floor (favors the vault).
pub fn calculate_assets(shares: u64, total_assets: u64, total_shares: u64, decimals_offset: u8) -> Result<u64> {
    let virtual_offset = 10u128.pow(decimals_offset as u32);

    let result = (shares as u128)
        .checked_mul(total_assets as u128 + 1)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(total_shares as u128 + virtual_offset)
        .ok_or(VaultError::DivisionByZero)?;

    u64::try_from(result).map_err(|_| VaultError::MathOverflow.into())
}

