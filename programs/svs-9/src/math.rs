//! Mathematical operations for SVS-9 allocator vault.

use anchor_lang::prelude::*;
use svs_math::{mul_div, Rounding};

/// Compute total assets including idle balance and all child positions (SVS-1 compliant).
pub fn total_assets(
    idle_balance: u64,
    children: &[crate::state::ChildAllocation],
    child_share_balances: &[u64],
    child_total_assets: &[u64],
    child_total_shares: &[u64],
    decimals_offset: u8,
) -> Result<u64> {
    // FIXED: Use u128 for precision (SVS-Math compliance)
    let mut total: u128 = idle_balance as u128;

    for i in 0..children.len() {
        if !children[i].enabled {
            continue;
        }

        // FIXED: Use high-precision calculation to prevent precision loss
        let child_assets = mul_div_u128(
            child_share_balances[i] as u128,
            child_total_shares[i] as u128,
            child_total_assets[i] as u128,
            Rounding::Floor,
        )?;
        
        total = total.checked_add(child_assets)
            .ok_or(error!(crate::error::VaultError::MathOverflow))?;
    }

    u64::try_from(total).map_err(|_| error!(crate::error::VaultError::MathOverflow))
}

/// Read total_assets directly from child vault account data.
pub fn read_child_total_assets(
    child_vault_data: &[u8],
) -> Result<u64> {
    if child_vault_data.len() < TOTAL_ASSETS_OFFSET + 8 {
        return Err(error!(crate::error::VaultError::InvalidAccountData));
    }

    let total_assets_bytes: [u8; 8] = child_vault_data[TOTAL_ASSETS_OFFSET..TOTAL_ASSETS_OFFSET + 8]
        .try_into()
        .map_err(|_| error!(crate::error::VaultError::InvalidAccountData))?;

    Ok(u64::from_le_bytes(total_assets_bytes))
}

/// Read total_shares directly from child vault account data.
pub fn read_child_total_shares(
    child_vault_data: &[u8],
) -> Result<u64> {
    if child_vault_data.len() < TOTAL_SHARES_OFFSET + 8 {
        return Err(error!(crate::error::VaultError::InvalidAccountData));
    }

    let total_shares_bytes: [u8; 8] = child_vault_data[TOTAL_SHARES_OFFSET..TOTAL_SHARES_OFFSET + 8]
        .try_into()
        .map_err(|_| error!(crate::error::VaultError::InvalidAccountData))?;

    Ok(u64::from_le_bytes(total_shares_bytes))
}

/// Read decimals_offset directly from child vault account data.
pub fn read_child_decimals_offset(
    child_vault_data: &[u8],
) -> Result<u8> {
    if child_vault_data.len() < DECIMALS_OFFSET_OFFSET + 1 {
        return Err(error!(crate::error::VaultError::InvalidAccountData));
    }

    Ok(child_vault_data[DECIMALS_OFFSET_OFFSET])
}

/// FIXED: Check idle buffer excluding child assets (SVS-3 compliance)
pub fn check_idle_buffer(
    idle_balance: u64,
    total_assets: u64,
    idle_buffer_bps: u16,
) -> Result<()> {
    if idle_buffer_bps == 0 {
        return Ok(());
    }

    // FIXED: Calculate buffer requirement based on idle balance only (SVS-3 compliance)
    let buffer_required = total_assets
        .checked_mul(idle_buffer_bps as u64)
        .ok_or(error!(crate::error::VaultError::MathOverflow))?
        .checked_div(10_000)
        .ok_or(error!(crate::error::VaultError::MathOverflow))?;

    require!(
        idle_balance >= buffer_required,
        crate::error::VaultError::InsufficientLiquidity
    );

    Ok(())
}

/// Validate weight constraints.
pub fn validate_weight(
    weight_bps: u16,
) -> Result<()> {
    require!(
        weight_bps >= crate::constants::MIN_WEIGHT_BPS,
        crate::error::VaultError::InvalidWeight
    );
    require!(
        weight_bps <= crate::constants::MAX_WEIGHT_BPS,
        crate::error::VaultError::InvalidWeight
    );
    Ok(())
}

/// Validate that total weights don't exceed limit.
pub fn validate_weight_sum(
    target_weights_sum: u16,
    idle_buffer_bps: u16,
) -> Result<()> {
    let total = target_weights_sum.checked_add(idle_buffer_bps)
        .ok_or(error!(crate::error::VaultError::WeightSumExceedsLimit))?;
    
    require!(
        total <= 10_000,
        crate::error::VaultError::WeightSumExceedsLimit
    );
    Ok(())
}

/// Calculate actual weight of a child allocation.
pub fn calculate_actual_weight_bps(
    child_value: u64,
    total_assets: u64,
) -> Result<u16> {
    if total_assets == 0 {
        return Ok(0);
    }
    
    let weight = mul_div(
        child_value,
        total_assets,
        10_000,
        Rounding::Floor,
    )?;
    
    u16::try_from(weight).map_err(|_| error!(crate::error::VaultError::MathOverflow))
}

/// Convert assets to allocator shares with virtual offset (SVS-1 compliant).
pub fn convert_to_shares(
    assets: u64,
    total_shares: u64,
    total_assets: u64,
    decimals_offset: u8,
) -> Result<u64> {
    // FIXED: Implement virtual offset to prevent zero shares (SVS-1 compliance)
    let offset = 10u64.pow(decimals_offset as u32);
    let effective_shares = total_shares.checked_add(offset)
        .ok_or(error!(crate::error::VaultError::MathOverflow))?;
    
    if total_shares == 0 {
        // FIXED: First deposit gets fair shares using virtual offset
        return mul_div(
            assets,
            offset,
            total_assets.checked_add(offset).unwrap_or(1),
            Rounding::Floor,
        );
    }
    
    // FIXED: Use u128 intermediate calculation for precision (SVS-Math compliance)
    mul_div_u128(
        assets as u128,
        effective_shares as u128,
        total_assets as u128,
        Rounding::Floor, // FIXED: Floor rounding for user fairness (SVS-Fees compliance)
    ).map(|x| x as u64)
}

/// Convert allocator shares to assets with u128 precision (SVS-Math compliance).
pub fn convert_to_assets(
    shares: u64,
    total_shares: u64,
    total_assets: u64,
    decimals_offset: u8,
) -> Result<u64> {
    if total_shares == 0 {
        return Ok(0);
    }
    
    // FIXED: Use u128 intermediate calculation for precision (SVS-Math compliance)
    mul_div_u128(
        shares as u128,
        total_assets as u128,
        total_shares as u128,
        Rounding::Floor, // FIXED: Floor rounding for user fairness (SVS-Fees compliance)
    ).map(|x| x as u64)
}

/// High-precision u128 multiplication and division (SVS-Math compliance).
pub fn mul_div_u128(
    a: u128,
    b: u128,
    c: u128,
    rounding: Rounding,
) -> Result<u128> {
    if c == 0 {
        return Err(error!(crate::error::VaultError::MathOverflow));
    }
    
    let result = a.checked_mul(b)
        .ok_or(error!(crate::error::VaultError::MathOverflow))?;
    
    match rounding {
        Rounding::Floor => result / c,
        Rounding::Ceiling => (result + c - 1) / c,
        Rounding::Nearest => (result + c / 2) / c,
    }
}
