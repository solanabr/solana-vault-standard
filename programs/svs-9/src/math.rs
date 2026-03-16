//! SVS-9 math utilities.
use anchor_lang::prelude::*;
use crate::error::AllocatorError;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rounding { Floor, Ceiling }

pub fn mul_div(value: u64, numerator: u64, denominator: u64, rounding: Rounding) -> Result<u64> {
    require!(denominator > 0, AllocatorError::DivisionByZero);
    let product = (value as u128).checked_mul(numerator as u128).ok_or(AllocatorError::MathOverflow)?;
    let result = match rounding {
        Rounding::Floor => product / (denominator as u128),
        Rounding::Ceiling => product.checked_add(denominator as u128 - 1).ok_or(AllocatorError::MathOverflow)? / (denominator as u128),
    };
    require!(result <= u64::MAX as u128, AllocatorError::MathOverflow);
    Ok(result as u64)
}

pub fn convert_to_shares(assets: u64, total_assets: u64, total_shares: u64, decimals_offset: u8, rounding: Rounding) -> Result<u64> {
    let offset = 10u64.checked_pow(decimals_offset as u32).ok_or(AllocatorError::MathOverflow)?;
    let virtual_shares = total_shares.checked_add(offset).ok_or(AllocatorError::MathOverflow)?;
    let virtual_assets = total_assets.checked_add(1).ok_or(AllocatorError::MathOverflow)?;
    mul_div(assets, virtual_shares, virtual_assets, rounding)
}

pub fn convert_to_assets(shares: u64, total_assets: u64, total_shares: u64, decimals_offset: u8, rounding: Rounding) -> Result<u64> {
    let offset = 10u64.checked_pow(decimals_offset as u32).ok_or(AllocatorError::MathOverflow)?;
    let virtual_shares = total_shares.checked_add(offset).ok_or(AllocatorError::MathOverflow)?;
    let virtual_assets = total_assets.checked_add(1).ok_or(AllocatorError::MathOverflow)?;
    mul_div(shares, virtual_assets, virtual_shares, rounding)
}

pub fn compute_min_idle(total_assets: u64, idle_buffer_bps: u16) -> Result<u64> {
    if idle_buffer_bps == 0 { return Ok(0); }
    mul_div(total_assets, idle_buffer_bps as u64, 10_000, Rounding::Ceiling)
}

pub fn check_idle_buffer(idle_after: u64, total_assets: u64, buffer_bps: u16) -> Result<()> {
    let min_idle = compute_min_idle(total_assets, buffer_bps)?;
    require!(idle_after >= min_idle, AllocatorError::InsufficientBuffer);
    Ok(())
}

pub fn validate_svs1_discriminator(data: &[u8]) -> Result<()> {
    use crate::constants::SVS1_DISCRIMINATOR;
    require!(data.len() >= 8, AllocatorError::InvalidAccountData);
    let disc: [u8; 8] = data[..8].try_into().map_err(|_| AllocatorError::InvalidAccountData)?;
    require!(disc == SVS1_DISCRIMINATOR, AllocatorError::UnsupportedChildVariant);
    Ok(())
}
