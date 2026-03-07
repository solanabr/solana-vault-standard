//! Share/asset conversion with inflation attack protection.

use crate::error::MathError;
use crate::mul_div::mul_div;
use crate::rounding::Rounding;

/// Convert assets to shares with virtual offset protection against inflation attacks.
///
/// Formula: shares = assets × (total_shares + 10^offset) / (total_assets + 1)
///
/// The virtual offset ensures that even in an empty vault, there's a "virtual"
/// share supply that prevents attackers from manipulating the share price.
///
/// # Arguments
/// * `assets` - Amount of assets to convert
/// * `total_assets` - Current total assets in the vault
/// * `total_shares` - Current total shares outstanding
/// * `decimals_offset` - Exponent for virtual offset (typically 9 - asset_decimals)
/// * `rounding` - Rounding direction (Floor for deposit, Ceiling for withdraw)
///
/// # Example
/// ```
/// use svs_math::{convert_to_shares, Rounding};
///
/// // Empty vault with 6-decimal asset (USDC), offset = 3
/// // Virtual shares = 0 + 10^3 = 1000
/// // Virtual assets = 0 + 1 = 1
/// // shares = 1_000_000 * 1000 / 1 = 1_000_000_000
/// let shares = convert_to_shares(1_000_000, 0, 0, 3, Rounding::Floor).unwrap();
/// assert_eq!(shares, 1_000_000_000);
/// ```
pub fn convert_to_shares(
    assets: u64,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64, MathError> {
    let offset = 10u64
        .checked_pow(decimals_offset as u32)
        .ok_or(MathError::Overflow)?;

    let virtual_shares = total_shares
        .checked_add(offset)
        .ok_or(MathError::Overflow)?;

    let virtual_assets = total_assets.checked_add(1).ok_or(MathError::Overflow)?;

    mul_div(assets, virtual_shares, virtual_assets, rounding)
}

/// Convert shares to assets with virtual offset protection.
///
/// Formula: assets = shares × (total_assets + 1) / (total_shares + 10^offset)
///
/// # Arguments
/// * `shares` - Amount of shares to convert
/// * `total_assets` - Current total assets in the vault
/// * `total_shares` - Current total shares outstanding
/// * `decimals_offset` - Exponent for virtual offset (typically 9 - asset_decimals)
/// * `rounding` - Rounding direction (Floor for redeem, Ceiling for mint)
pub fn convert_to_assets(
    shares: u64,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64, MathError> {
    let offset = 10u64
        .checked_pow(decimals_offset as u32)
        .ok_or(MathError::Overflow)?;

    let virtual_shares = total_shares
        .checked_add(offset)
        .ok_or(MathError::Overflow)?;

    let virtual_assets = total_assets.checked_add(1).ok_or(MathError::Overflow)?;

    mul_div(shares, virtual_assets, virtual_shares, rounding)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_convert_to_shares_empty_vault() {
        // Empty vault with 6-decimal asset (USDC), offset = 3
        // Virtual shares = 0 + 10^3 = 1000
        // Virtual assets = 0 + 1 = 1
        // shares = 1_000_000 * 1000 / 1 = 1_000_000_000
        let shares = convert_to_shares(1_000_000, 0, 0, 3, Rounding::Floor).unwrap();
        assert_eq!(shares, 1_000_000_000);
    }

    #[test]
    fn test_convert_to_shares_proportional() {
        // Vault has 1M assets and 1M shares, offset = 3
        // User deposits 100k assets
        // shares = 100_000 * (1_000_000 + 1000) / (1_000_000 + 1)
        //        ≈ 100_000 * 1.000999 ≈ 100_099 (floor)
        let shares = convert_to_shares(100_000, 1_000_000, 1_000_000, 3, Rounding::Floor).unwrap();
        assert!(shares > 99_000 && shares < 101_000);
    }

    #[test]
    fn test_convert_to_assets_proportional() {
        // Vault has 1M assets and 1M shares, offset = 3
        // User redeems 100k shares
        let assets = convert_to_assets(100_000, 1_000_000, 1_000_000, 3, Rounding::Floor).unwrap();
        assert!(assets > 99_000 && assets < 101_000);
    }

    #[test]
    fn test_inflation_attack_protection() {
        // Attacker scenario: donate 1M to empty vault, then deposit 1
        // Without offset: attacker could manipulate price
        // With offset (3): virtual shares = 1000, virtual assets = 1M + 1
        // Attacker deposits 1: shares = 1 * 1000 / 1_000_001 = 0 (floor)
        let shares = convert_to_shares(1, 1_000_000, 0, 3, Rounding::Floor).unwrap();
        assert_eq!(shares, 0); // Attack yields nothing
    }

    #[test]
    fn test_rounding_favors_vault() {
        // deposit: floor (user gets less)
        let deposit_shares = convert_to_shares(100, 1000, 1000, 3, Rounding::Floor).unwrap();

        // redeem: floor (user gets less)
        let redeem_assets = convert_to_assets(100, 1000, 1000, 3, Rounding::Floor).unwrap();

        // withdraw: ceiling shares (user burns more)
        let withdraw_shares = convert_to_shares(100, 1000, 1000, 3, Rounding::Ceiling).unwrap();

        // mint: ceiling assets (user pays more)
        let mint_assets = convert_to_assets(100, 1000, 1000, 3, Rounding::Ceiling).unwrap();

        // Ceiling should be >= Floor
        assert!(withdraw_shares >= deposit_shares);
        assert!(mint_assets >= redeem_assets);
    }

    #[test]
    fn test_max_values() {
        // Test with large but valid values
        let large = u64::MAX / 2;
        let result = convert_to_shares(large, large, large, 0, Rounding::Floor);
        assert!(result.is_ok());
    }

    #[test]
    fn test_9_decimal_asset() {
        // 9-decimal asset means offset = 0, so 10^0 = 1
        // Empty vault: shares = assets * 1 / 1 = assets
        let shares = convert_to_shares(1_000_000_000, 0, 0, 0, Rounding::Floor).unwrap();
        assert_eq!(shares, 1_000_000_000);
    }

    #[test]
    fn test_roundtrip_consistency() {
        // Depositing and redeeming should be close to original (minus rounding)
        let assets = 1_000_000u64;
        let total_assets = 10_000_000u64;
        let total_shares = 10_000_000u64;
        let offset = 3u8;

        let shares =
            convert_to_shares(assets, total_assets, total_shares, offset, Rounding::Floor).unwrap();
        let recovered = convert_to_assets(
            shares,
            total_assets + assets,
            total_shares + shares,
            offset,
            Rounding::Floor,
        )
        .unwrap();

        // Due to rounding, recovered should be <= original
        assert!(recovered <= assets);
        // But should be close (within 1% for these values)
        assert!(recovered > assets * 99 / 100);
    }
}
