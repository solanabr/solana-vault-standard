//! Core multiplication and division with configurable rounding.

use crate::error::MathError;
use crate::rounding::Rounding;

/// Safe multiplication then division with configurable rounding.
///
/// Computes: (value × numerator) / denominator
/// Uses u128 intermediate to prevent overflow.
///
/// # Arguments
/// * `value` - The base value to multiply
/// * `numerator` - The multiplier
/// * `denominator` - The divisor (must be > 0)
/// * `rounding` - Whether to floor or ceiling the result
///
/// # Returns
/// The computed result, or an error if overflow or division by zero occurs.
///
/// # Example
/// ```
/// use svs_math::{mul_div, Rounding};
///
/// // 100 * 3 / 2 = 150 (exact)
/// assert_eq!(mul_div(100, 3, 2, Rounding::Floor).unwrap(), 150);
///
/// // 100 * 1 / 3 = 33 (floor) or 34 (ceiling)
/// assert_eq!(mul_div(100, 1, 3, Rounding::Floor).unwrap(), 33);
/// assert_eq!(mul_div(100, 1, 3, Rounding::Ceiling).unwrap(), 34);
/// ```
pub fn mul_div(
    value: u64,
    numerator: u64,
    denominator: u64,
    rounding: Rounding,
) -> Result<u64, MathError> {
    if denominator == 0 {
        return Err(MathError::DivisionByZero);
    }

    let product = (value as u128)
        .checked_mul(numerator as u128)
        .ok_or(MathError::Overflow)?;

    let result = match rounding {
        Rounding::Floor => product / (denominator as u128),
        Rounding::Ceiling => {
            let denom = denominator as u128;
            // (product + denominator - 1) / denominator
            product
                .checked_add(denom)
                .ok_or(MathError::Overflow)?
                .checked_sub(1)
                .ok_or(MathError::Overflow)?
                / denom
        }
    };

    if result > u64::MAX as u128 {
        return Err(MathError::Overflow);
    }

    Ok(result as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mul_div_floor() {
        // 100 * 3 / 2 = 150 (exact)
        assert_eq!(mul_div(100, 3, 2, Rounding::Floor).unwrap(), 150);
        // 100 * 1 / 3 = 33 (floor)
        assert_eq!(mul_div(100, 1, 3, Rounding::Floor).unwrap(), 33);
    }

    #[test]
    fn test_mul_div_ceiling() {
        // 100 * 3 / 2 = 150 (exact)
        assert_eq!(mul_div(100, 3, 2, Rounding::Ceiling).unwrap(), 150);
        // 100 * 1 / 3 = 34 (ceiling)
        assert_eq!(mul_div(100, 1, 3, Rounding::Ceiling).unwrap(), 34);
    }

    #[test]
    fn test_division_by_zero() {
        let result = mul_div(100, 100, 0, Rounding::Floor);
        assert_eq!(result, Err(MathError::DivisionByZero));
    }

    #[test]
    fn test_large_values_no_overflow() {
        // Test with large but valid values using u128 intermediate
        let large = u64::MAX / 2;
        let result = mul_div(large, 2, 2, Rounding::Floor);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), large);
    }

    #[test]
    fn test_result_overflow() {
        // Result would exceed u64::MAX
        let result = mul_div(u64::MAX, 2, 1, Rounding::Floor);
        assert_eq!(result, Err(MathError::Overflow));
    }

    #[test]
    fn test_zero_values() {
        assert_eq!(mul_div(0, 100, 1, Rounding::Floor).unwrap(), 0);
        assert_eq!(mul_div(100, 0, 1, Rounding::Floor).unwrap(), 0);
        assert_eq!(mul_div(0, 0, 1, Rounding::Floor).unwrap(), 0);
    }
}
