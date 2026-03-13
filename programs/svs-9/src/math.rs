//! Mathematical operations for SVS-9 allocator vault.

use anchor_lang::prelude::*;
use svs_math::{mul_div, Rounding};

/// Compute total assets including idle balance and all child positions.
pub fn total_assets(
    idle_balance: u64,
    children: &[crate::state::ChildAllocation],
    child_share_balances: &[u64],
    child_total_assets: &[u64],
    child_total_shares: &[u64],
    decimals_offset: u8,
) -> Result<u64> {
    let mut total: u128 = idle_balance as u128;

    for i in 0..children.len() {
        if !children[i].enabled {
            continue;
        }

        // child_assets = child_shares * child_total_assets / child_total_shares
        let child_assets = mul_div(
            child_share_balances[i],
            child_total_shares[i],
            child_total_assets[i],
            Rounding::Floor,
        )?;
        
        total = total.checked_add(child_assets as u128)
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

/// Validate idle buffer constraint.
pub fn check_idle_buffer(
    idle_after: u64,
    total_assets: u64,
    buffer_bps: u16,
) -> Result<()> {
    let min_idle = mul_div(
        total_assets,
        buffer_bps as u64,
        10_000,
        Rounding::Ceiling,
    )?;
    
    require!(idle_after >= min_idle, crate::error::VaultError::InsufficientBuffer);
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

/// Convert assets to allocator shares.
pub fn convert_to_shares(
    assets: u64,
    total_shares: u64,
    total_assets: u64,
    decimals_offset: u8,
) -> Result<u64> {
    if total_shares == 0 {
        return Ok(0);
    }
    
    mul_div(
        assets,
        total_shares,
        total_assets,
        Rounding::Floor,
    )
}

/// Convert allocator shares to assets.
pub fn convert_to_assets(
    shares: u64,
    total_shares: u64,
    total_assets: u64,
    decimals_offset: u8,
) -> Result<u64> {
    if total_shares == 0 {
        return Ok(0);
    }
    
    mul_div(
        shares,
        total_assets,
        total_shares,
        Rounding::Floor,
    )
}
