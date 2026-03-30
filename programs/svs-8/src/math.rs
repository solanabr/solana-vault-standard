//! Math module for SVS-8 — wraps svs_math with Anchor error conversion.

use anchor_lang::prelude::*;
use crate::error::VaultError;

pub use svs_math::Rounding;

pub fn convert_to_shares(
    assets: u64, total_assets: u64, total_shares: u64,
    decimals_offset: u8, rounding: Rounding,
) -> Result<u64> {
    svs_math::convert_to_shares(assets, total_assets, total_shares, decimals_offset, rounding)
        .map_err(|e| match e {
            svs_math::MathError::Overflow => VaultError::MathOverflow.into(),
            svs_math::MathError::DivisionByZero => VaultError::DivisionByZero.into(),
        })
}

pub fn convert_to_assets(
    shares: u64, total_assets: u64, total_shares: u64,
    decimals_offset: u8, rounding: Rounding,
) -> Result<u64> {
    svs_math::convert_to_assets(shares, total_assets, total_shares, decimals_offset, rounding)
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

/// Total portfolio value in base_decimals units.
pub fn total_portfolio_value(
    balances: &[u64], prices: &[u64], asset_decimals: &[u8], base_decimals: u8,
) -> Result<u64> {
    require!(
        balances.len() == prices.len() && balances.len() == asset_decimals.len(),
        VaultError::MathOverflow
    );
    const PRICE_SCALE: u128 = 1_000_000_000;
    let mut total: u128 = 0;
    for i in 0..balances.len() {
        let num = (balances[i] as u128)
            .checked_mul(prices[i] as u128).ok_or(VaultError::MathOverflow)?
            .checked_mul(10u128.pow(base_decimals as u32)).ok_or(VaultError::MathOverflow)?;
        let den = PRICE_SCALE
            .checked_mul(10u128.pow(asset_decimals[i] as u32)).ok_or(VaultError::MathOverflow)?;
        total = total.checked_add(num.checked_div(den).ok_or(VaultError::DivisionByZero)?)
            .ok_or(VaultError::MathOverflow)?;
    }
    u64::try_from(total).map_err(|_| error!(VaultError::MathOverflow))
}

/// Value of `amount` tokens at oracle price, in base_decimals units.
pub fn oracle_value_for_amount(price: u64, amount: u64, asset_decimals: u8, base_decimals: u8) -> Result<u64> {
    const PRICE_SCALE: u128 = 1_000_000_000;
    let num = (amount as u128)
        .checked_mul(price as u128).ok_or(VaultError::MathOverflow)?
        .checked_mul(10u128.pow(base_decimals as u32)).ok_or(VaultError::MathOverflow)?;
    let den = PRICE_SCALE
        .checked_mul(10u128.pow(asset_decimals as u32)).ok_or(VaultError::MathOverflow)?;
    u64::try_from(num.checked_div(den).ok_or(VaultError::DivisionByZero)?)
        .map_err(|_| error!(VaultError::MathOverflow))
}

pub fn read_token_balance(info: &anchor_lang::prelude::AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    require!(data.len() >= 72, crate::error::VaultError::MathOverflow);
    let amount = u64::from_le_bytes(
        data[64..72].try_into().map_err(|_| anchor_lang::error!(crate::error::VaultError::MathOverflow))?
    );
    Ok(amount)
}
