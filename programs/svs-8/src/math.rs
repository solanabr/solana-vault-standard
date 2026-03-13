use anchor_lang::prelude::*;
use crate::error::VaultError;

pub enum Rounding {
    Floor,
    Ceiling,
}

/// Multiply then divide with rounding direction
pub fn mul_div(a: u64, b: u64, c: u64, rounding: Rounding) -> Result<u64> {
    require!(c > 0, VaultError::DivisionByZero);
    let numerator = (a as u128)
        .checked_mul(b as u128)
        .ok_or(VaultError::MathOverflow)?;
    let result = match rounding {
        Rounding::Floor => numerator / (c as u128),
        Rounding::Ceiling => numerator
            .checked_add((c as u128) - 1)
            .ok_or(VaultError::MathOverflow)?
            / (c as u128),
    };
    u64::try_from(result).map_err(|_| error!(VaultError::MathOverflow))
}

/// Total portfolio value in base units (e.g. USD with 6 decimals)
/// value_i = balance_i * price_i / 10^asset_decimals_i
pub fn total_portfolio_value(
    balances: &[u64],
    prices: &[u64],
    asset_decimals: &[u8],
) -> Result<u64> {
    require_eq!(balances.len(), prices.len(), VaultError::MathOverflow);
    require_eq!(balances.len(), asset_decimals.len(), VaultError::MathOverflow);

    let mut total: u128 = 0;
    for i in 0..balances.len() {
        let decimals_pow = 10u128
            .checked_pow(asset_decimals[i] as u32)
            .ok_or(VaultError::MathOverflow)?;
        let value = (balances[i] as u128)
            .checked_mul(prices[i] as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(decimals_pow)
            .ok_or(VaultError::DivisionByZero)?;
        total = total.checked_add(value).ok_or(VaultError::MathOverflow)?;
    }
    u64::try_from(total).map_err(|_| error!(VaultError::MathOverflow))
}

/// Convert deposit value to shares (floor — favors vault)
pub fn convert_to_shares(
    deposit_value: u64,
    total_shares: u64,
    total_value: u64,
    offset: u64,
) -> Result<u64> {
    mul_div(
        deposit_value,
        total_shares.checked_add(offset).ok_or(VaultError::MathOverflow)?,
        total_value.checked_add(1).ok_or(VaultError::MathOverflow)?,
        Rounding::Floor,
    )
}

/// Convert shares to asset value (floor — favors vault)
pub fn convert_to_assets(
    shares: u64,
    total_shares: u64,
    total_value: u64,
    offset: u64,
) -> Result<u64> {
    mul_div(
        shares,
        total_value.checked_add(1).ok_or(VaultError::MathOverflow)?,
        total_shares.checked_add(offset).ok_or(VaultError::MathOverflow)?,
        Rounding::Floor,
    )
}

/// Normalize a Pyth price to base unit value for a given amount
/// price: raw Pyth price (i64 cast to u64)
/// expo: Pyth exponent (negative, e.g. -8)
/// amount: token amount in native units
/// asset_decimals: token decimals
/// base_decimals: target base unit decimals (e.g. 6 for USD)
pub fn normalize_price_for_amount(
    price: u64,
    expo: i32,
    amount: u64,
    asset_decimals: u8,
    base_decimals: u8,
) -> Result<u64> {
    // value = amount * price * 10^(base_decimals + expo) / 10^asset_decimals
    // We compute carefully to avoid overflow
    let amount128 = amount as u128;
    let price128 = price as u128;

    // scale = 10^base_decimals / 10^asset_decimals / 10^(-expo)
    // = 10^(base_decimals - asset_decimals + expo)
    let scale_exp: i32 = base_decimals as i32 - asset_decimals as i32 + expo;

    let value = if scale_exp >= 0 {
        let scale = 10u128
            .checked_pow(scale_exp as u32)
            .ok_or(VaultError::MathOverflow)?;
        amount128
            .checked_mul(price128)
            .ok_or(VaultError::MathOverflow)?
            .checked_mul(scale)
            .ok_or(VaultError::MathOverflow)?
    } else {
        let scale = 10u128
            .checked_pow((-scale_exp) as u32)
            .ok_or(VaultError::MathOverflow)?;
        amount128
            .checked_mul(price128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(scale)
            .ok_or(VaultError::DivisionByZero)?
    };

    u64::try_from(value).map_err(|_| error!(VaultError::MathOverflow))
}

/// Read and validate oracle price, returning price scaled to base_decimals
/// price is stored as PRICE_SCALE (1e9) units per token
/// Returns value in base_decimals units for given amount
pub fn oracle_value_for_amount(
    price: u64,
    amount: u64,
    asset_decimals: u8,
    base_decimals: u8,
) -> Result<u64> {
    const PRICE_SCALE: u64 = 1_000_000_000;

    // value = amount * price * 10^base_decimals / (PRICE_SCALE * 10^asset_decimals)
    let numerator = (amount as u128)
        .checked_mul(price as u128)
        .ok_or(VaultError::MathOverflow)?
        .checked_mul(10u128.pow(base_decimals as u32))
        .ok_or(VaultError::MathOverflow)?;

    let denominator = (PRICE_SCALE as u128)
        .checked_mul(10u128.pow(asset_decimals as u32))
        .ok_or(VaultError::MathOverflow)?;

    let value = numerator
        .checked_div(denominator)
        .ok_or(VaultError::DivisionByZero)?;

    u64::try_from(value).map_err(|_| error!(VaultError::MathOverflow))
}

/// Read SPL token account balance from raw account data
/// TokenAccount layout: [0..8] disc, [8..40] mint, [40..72] owner, [72..80] amount
pub fn read_token_balance(info: &anchor_lang::prelude::AccountInfo) -> anchor_lang::Result<u64> {
    let data = info.try_borrow_data()?;
    require!(data.len() >= 80, crate::error::VaultError::MathOverflow);
    // SPL token account: amount is at offset 64 for Token program (not Token-2022)
    // Layout: mint(32) + owner(32) + amount(8) = offset 72 for Token-2022 with discriminator
    // Standard SPL (no discriminator): amount at offset 64
    let amount = u64::from_le_bytes(
        data[64..72].try_into().map_err(|_| anchor_lang::error!(crate::error::VaultError::MathOverflow))?
    );
    Ok(amount)
}
