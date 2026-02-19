use anchor_lang::prelude::*;

use crate::error::VaultError;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rounding {
    Floor,
    Ceiling,
}

/// Convert assets to shares with virtual offset protection against inflation attacks.
///
/// Formula: shares = assets × (total_shares + 10^offset) / (total_assets + 1)
///
/// The virtual offset ensures that even in an empty vault, there's a "virtual"
/// share supply that prevents attackers from manipulating the share price.
pub fn convert_to_shares(
    assets: u64,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64> {
    let offset = 10u64
        .checked_pow(decimals_offset as u32)
        .ok_or(VaultError::MathOverflow)?;

    let virtual_shares = total_shares
        .checked_add(offset)
        .ok_or(VaultError::MathOverflow)?;

    let virtual_assets = total_assets
        .checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    mul_div(assets, virtual_shares, virtual_assets, rounding)
}

/// Convert shares to assets with virtual offset protection.
///
/// Formula: assets = shares × (total_assets + 1) / (total_shares + 10^offset)
pub fn convert_to_assets(
    shares: u64,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64> {
    let offset = 10u64
        .checked_pow(decimals_offset as u32)
        .ok_or(VaultError::MathOverflow)?;

    let virtual_shares = total_shares
        .checked_add(offset)
        .ok_or(VaultError::MathOverflow)?;

    let virtual_assets = total_assets
        .checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    mul_div(shares, virtual_assets, virtual_shares, rounding)
}

/// Safe multiplication then division with configurable rounding.
///
/// Computes: (value × numerator) / denominator
/// Uses u128 intermediate to prevent overflow.
pub fn mul_div(value: u64, numerator: u64, denominator: u64, rounding: Rounding) -> Result<u64> {
    require!(denominator > 0, VaultError::DivisionByZero);

    let product = (value as u128)
        .checked_mul(numerator as u128)
        .ok_or(VaultError::MathOverflow)?;

    let result = match rounding {
        Rounding::Floor => product / (denominator as u128),
        Rounding::Ceiling => {
            let denom = denominator as u128;
            product
                .checked_add(denom)
                .ok_or(VaultError::MathOverflow)?
                .checked_sub(1)
                .ok_or(VaultError::MathOverflow)?
                / denom
        }
    };

    require!(result <= u64::MAX as u128, VaultError::MathOverflow);
    Ok(result as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mul_div_floor() {
        // 100 * 3 / 2 = 150 (floor)
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
    fn test_division_by_zero() {
        let result = mul_div(100, 100, 0, Rounding::Floor);
        assert!(result.is_err());
    }

    #[test]
    fn test_max_values() {
        // Test with large but valid values
        let large = u64::MAX / 2;
        let result = convert_to_shares(large, large, large, 0, Rounding::Floor);
        assert!(result.is_ok());
    }
}
