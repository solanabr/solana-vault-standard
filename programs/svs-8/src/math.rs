use anchor_lang::prelude::*;

use crate::error::VaultError;

pub use svs_math::Rounding;

pub fn mul_div(value: u64, numerator: u64, denominator: u64, rounding: Rounding) -> Result<u64> {
    svs_math::mul_div(value, numerator, denominator, rounding).map_err(|e| match e {
        svs_math::MathError::Overflow => VaultError::MathOverflow.into(),
        svs_math::MathError::DivisionByZero => VaultError::DivisionByZero.into(),
    })
}

/// Compute the total portfolio value in base units.
///
/// For each asset: value = balance * price / 10^asset_decimals
/// Sum all values. Prices are in base units per whole token.
pub fn total_portfolio_value(
    balances: &[u64],
    prices: &[u64],
    asset_decimals: &[u8],
) -> Result<u64> {
    let mut total: u128 = 0;
    for i in 0..balances.len() {
        let value = (balances[i] as u128)
            .checked_mul(prices[i] as u128)
            .ok_or(error!(VaultError::MathOverflow))?
            .checked_div(
                10u128
                    .checked_pow(asset_decimals[i] as u32)
                    .ok_or(error!(VaultError::MathOverflow))?,
            )
            .ok_or(error!(VaultError::DivisionByZero))?;
        total = total
            .checked_add(value)
            .ok_or(error!(VaultError::MathOverflow))?;
    }
    u64::try_from(total).map_err(|_| error!(VaultError::MathOverflow))
}

/// Convert a deposit value to shares using the portfolio model.
///
/// shares = deposit_value * (total_shares + offset) / (total_value + 1)
pub fn portfolio_convert_to_shares(
    deposit_value: u64,
    total_shares: u64,
    total_value: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64> {
    let offset = 10u64
        .checked_pow(decimals_offset as u32)
        .ok_or(error!(VaultError::MathOverflow))?;

    let virtual_shares = total_shares
        .checked_add(offset)
        .ok_or(error!(VaultError::MathOverflow))?;

    let virtual_value = total_value
        .checked_add(1)
        .ok_or(error!(VaultError::MathOverflow))?;

    mul_div(deposit_value, virtual_shares, virtual_value, rounding)
}

/// Convert shares to a value in base units using the portfolio model.
///
/// value = shares * (total_value + 1) / (total_shares + offset)
pub fn portfolio_convert_to_assets(
    shares: u64,
    total_shares: u64,
    total_value: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64> {
    let offset = 10u64
        .checked_pow(decimals_offset as u32)
        .ok_or(error!(VaultError::MathOverflow))?;

    let virtual_shares = total_shares
        .checked_add(offset)
        .ok_or(error!(VaultError::MathOverflow))?;

    let virtual_value = total_value
        .checked_add(1)
        .ok_or(error!(VaultError::MathOverflow))?;

    mul_div(shares, virtual_value, virtual_shares, rounding)
}

/// Compute the value of a single asset balance in base units.
pub fn asset_value_in_base(balance: u64, price: u64, asset_decimals: u8) -> Result<u64> {
    let divisor = 10u128
        .checked_pow(asset_decimals as u32)
        .ok_or(error!(VaultError::MathOverflow))?;

    let value = (balance as u128)
        .checked_mul(price as u128)
        .ok_or(error!(VaultError::MathOverflow))?
        .checked_div(divisor)
        .ok_or(error!(VaultError::DivisionByZero))?;

    u64::try_from(value).map_err(|_| error!(VaultError::MathOverflow))
}
