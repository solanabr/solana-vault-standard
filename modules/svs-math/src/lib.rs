//! SVS Math - Shared math utilities for Solana Vault Standard programs.
//!
//! This crate provides the core mathematical operations used across all SVS vault variants:
//! - Safe multiplication and division with configurable rounding
//! - Share/asset conversion with inflation attack protection
//!
//! # Design Principles
//!
//! 1. **No Anchor dependency**: Pure Rust for maximum reusability
//! 2. **u128 intermediates**: Prevent overflow in multiplication before division
//! 3. **Vault-favoring rounding**: Protect existing shareholders
//! 4. **Virtual offset**: Inflation attack protection via virtual shares/assets
//!
//! # Rounding Strategy
//!
//! | Operation | Rounding | Effect |
//! |-----------|----------|--------|
//! | deposit   | Floor    | User gets fewer shares |
//! | mint      | Ceiling  | User pays more assets |
//! | withdraw  | Ceiling  | User burns more shares |
//! | redeem    | Floor    | User gets fewer assets |
//!
//! # Example
//!
//! ```
//! use svs_math::{convert_to_shares, convert_to_assets, mul_div, Rounding, MathError};
//!
//! // Convert 1M assets to shares in an empty vault (6-decimal asset)
//! let shares = convert_to_shares(1_000_000, 0, 0, 3, Rounding::Floor).unwrap();
//!
//! // Simple multiplication/division
//! let result = mul_div(100, 3, 2, Rounding::Floor).unwrap();
//! assert_eq!(result, 150);
//! ```

mod convert;
mod error;
mod mul_div;
mod rounding;

pub use convert::{convert_to_assets, convert_to_shares};
pub use error::MathError;
pub use mul_div::mul_div;
pub use rounding::Rounding;

/// Basis points denominator (100% = 10000 bps).
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Maximum supported decimals for assets.
pub const MAX_DECIMALS: u8 = 9;

/// Apply a basis points fee to an amount.
///
/// Returns (amount_after_fee, fee_amount) with ceiling rounding on fee.
///
/// # Example
/// ```
/// use svs_math::apply_bps_fee;
///
/// // 1% fee (100 bps) on 10000
/// let (after, fee) = apply_bps_fee(10000, 100).unwrap();
/// assert_eq!(fee, 100);
/// assert_eq!(after, 9900);
/// ```
pub fn apply_bps_fee(amount: u64, fee_bps: u16) -> Result<(u64, u64), MathError> {
    if fee_bps == 0 {
        return Ok((amount, 0));
    }

    // fee = amount * fee_bps / 10000, ceiling
    let fee = mul_div(amount, fee_bps as u64, BPS_DENOMINATOR, Rounding::Ceiling)?;
    let after = amount.checked_sub(fee).ok_or(MathError::Overflow)?;

    Ok((after, fee))
}

/// Calculate the decimals offset for inflation attack protection.
///
/// offset = MAX_DECIMALS - asset_decimals
/// This ensures 10^offset virtual shares exist.
pub fn calculate_decimals_offset(asset_decimals: u8) -> Result<u8, MathError> {
    MAX_DECIMALS
        .checked_sub(asset_decimals)
        .ok_or(MathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_bps_fee() {
        // 1% fee (100 bps) on 10000
        let (after, fee) = apply_bps_fee(10000, 100).unwrap();
        assert_eq!(fee, 100);
        assert_eq!(after, 9900);
    }

    #[test]
    fn test_apply_bps_fee_zero() {
        let (after, fee) = apply_bps_fee(10000, 0).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(after, 10000);
    }

    #[test]
    fn test_apply_bps_fee_ceiling() {
        // 1 bps on 100 = 0.01 -> ceiling = 1
        let (after, fee) = apply_bps_fee(100, 1).unwrap();
        assert_eq!(fee, 1);
        assert_eq!(after, 99);
    }

    #[test]
    fn test_calculate_decimals_offset() {
        assert_eq!(calculate_decimals_offset(6).unwrap(), 3); // USDC
        assert_eq!(calculate_decimals_offset(9).unwrap(), 0); // SOL
        assert_eq!(calculate_decimals_offset(0).unwrap(), 9); // No decimals
    }

    #[test]
    fn test_calculate_decimals_offset_overflow() {
        // 10 decimals would overflow (9 - 10 = underflow)
        assert!(calculate_decimals_offset(10).is_err());
    }
}
