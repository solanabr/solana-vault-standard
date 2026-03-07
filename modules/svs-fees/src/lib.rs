//! SVS Fees - Fee module for Solana Vault Standard programs.
//!
//! This crate provides fee calculation utilities for SVS vaults:
//! - Entry fees: Charged on deposits (deducted from shares)
//! - Exit fees: Charged on withdrawals (deducted from assets)
//! - Management fees: Annual fee on AUM, accrued over time
//! - Performance fees: Fee on profits above high-water mark
//!
//! All fees are specified in basis points (bps), where 10000 bps = 100%.
//!
//! # Fee Limits
//!
//! | Fee Type | Max BPS | Max % |
//! |----------|---------|-------|
//! | Entry | 1000 | 10% |
//! | Exit | 1000 | 10% |
//! | Management | 500 | 5% |
//! | Performance | 3000 | 30% |
//!
//! # Rounding Strategy
//!
//! All fee calculations use ceiling rounding to favor the vault:
//! - Entry fee: Ceiling (user pays more)
//! - Exit fee: Ceiling (user receives less)
//!
//! # Example
//!
//! ```
//! use svs_fees::{apply_entry_fee, apply_exit_fee, accrue_management_fee};
//!
//! // Apply 1% entry fee to 1000 shares
//! let (net_shares, fee_shares) = apply_entry_fee(1000, 100).unwrap();
//! assert_eq!(net_shares, 990);
//! assert_eq!(fee_shares, 10);
//!
//! // Calculate management fee for 30 days on 1M assets (2% annual)
//! let fee = accrue_management_fee(1_000_000, 200, 30 * 86400).unwrap();
//! ```

mod constants;
mod error;
mod functions;

pub use constants::*;
pub use error::FeeError;
pub use functions::*;

/// Validate entry fee is within limits.
pub fn validate_entry_fee(fee_bps: u16) -> Result<(), FeeError> {
    if fee_bps > MAX_ENTRY_FEE_BPS {
        return Err(FeeError::EntryFeeExceedsMax);
    }
    Ok(())
}

/// Validate exit fee is within limits.
pub fn validate_exit_fee(fee_bps: u16) -> Result<(), FeeError> {
    if fee_bps > MAX_EXIT_FEE_BPS {
        return Err(FeeError::ExitFeeExceedsMax);
    }
    Ok(())
}

/// Validate management fee is within limits.
pub fn validate_management_fee(fee_bps: u16) -> Result<(), FeeError> {
    if fee_bps > MAX_MANAGEMENT_FEE_BPS {
        return Err(FeeError::ManagementFeeExceedsMax);
    }
    Ok(())
}

/// Validate performance fee is within limits.
pub fn validate_performance_fee(fee_bps: u16) -> Result<(), FeeError> {
    if fee_bps > MAX_PERFORMANCE_FEE_BPS {
        return Err(FeeError::PerformanceFeeExceedsMax);
    }
    Ok(())
}

/// Validate all fee parameters at once.
pub fn validate_fee_config(
    entry_fee_bps: u16,
    exit_fee_bps: u16,
    management_fee_bps: u16,
    performance_fee_bps: u16,
) -> Result<(), FeeError> {
    validate_entry_fee(entry_fee_bps)?;
    validate_exit_fee(exit_fee_bps)?;
    validate_management_fee(management_fee_bps)?;
    validate_performance_fee(performance_fee_bps)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_entry_fee() {
        assert!(validate_entry_fee(0).is_ok());
        assert!(validate_entry_fee(500).is_ok());
        assert!(validate_entry_fee(1000).is_ok());
        assert!(validate_entry_fee(1001).is_err());
    }

    #[test]
    fn test_validate_exit_fee() {
        assert!(validate_exit_fee(0).is_ok());
        assert!(validate_exit_fee(1000).is_ok());
        assert!(validate_exit_fee(1001).is_err());
    }

    #[test]
    fn test_validate_management_fee() {
        assert!(validate_management_fee(0).is_ok());
        assert!(validate_management_fee(500).is_ok());
        assert!(validate_management_fee(501).is_err());
    }

    #[test]
    fn test_validate_performance_fee() {
        assert!(validate_performance_fee(0).is_ok());
        assert!(validate_performance_fee(3000).is_ok());
        assert!(validate_performance_fee(3001).is_err());
    }

    #[test]
    fn test_validate_fee_config() {
        assert!(validate_fee_config(100, 50, 200, 2000).is_ok());
        assert!(validate_fee_config(1001, 50, 200, 2000).is_err());
        assert!(validate_fee_config(100, 1001, 200, 2000).is_err());
        assert!(validate_fee_config(100, 50, 501, 2000).is_err());
        assert!(validate_fee_config(100, 50, 200, 3001).is_err());
    }
}
