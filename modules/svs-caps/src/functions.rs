//! Core cap enforcement functions.

use crate::error::CapError;

/// Check if a deposit would exceed the global vault cap.
///
/// # Arguments
/// * `total_assets` - Current total assets in vault
/// * `deposit_amount` - Amount being deposited
/// * `global_cap` - Maximum total assets allowed (0 = unlimited)
///
/// # Returns
/// Ok(()) if deposit is allowed, Err(GlobalCapExceeded) otherwise
///
/// # Example
/// ```
/// use svs_caps::check_global_cap;
///
/// // Vault has 900k assets, cap is 1M, depositing 50k
/// assert!(check_global_cap(900_000, 50_000, 1_000_000).is_ok());
///
/// // Vault has 900k assets, cap is 1M, depositing 200k -> exceeds
/// assert!(check_global_cap(900_000, 200_000, 1_000_000).is_err());
///
/// // Cap of 0 means unlimited
/// assert!(check_global_cap(900_000, 200_000, 0).is_ok());
/// ```
pub fn check_global_cap(
    total_assets: u64,
    deposit_amount: u64,
    global_cap: u64,
) -> Result<(), CapError> {
    // 0 means unlimited
    if global_cap == 0 {
        return Ok(());
    }

    let new_total = total_assets
        .checked_add(deposit_amount)
        .ok_or(CapError::MathOverflow)?;

    if new_total > global_cap {
        return Err(CapError::GlobalCapExceeded);
    }

    Ok(())
}

/// Check if a deposit would exceed the per-user cap.
///
/// # Arguments
/// * `user_cumulative` - User's cumulative deposited assets
/// * `deposit_amount` - Amount being deposited
/// * `per_user_cap` - Maximum assets per user (0 = unlimited)
///
/// # Returns
/// Ok(()) if deposit is allowed, Err(UserCapExceeded) otherwise
///
/// # Example
/// ```
/// use svs_caps::check_user_cap;
///
/// // User has deposited 50k, cap is 100k, depositing 40k
/// assert!(check_user_cap(50_000, 40_000, 100_000).is_ok());
///
/// // User has deposited 50k, cap is 100k, depositing 60k -> exceeds
/// assert!(check_user_cap(50_000, 60_000, 100_000).is_err());
///
/// // Cap of 0 means unlimited
/// assert!(check_user_cap(50_000, 60_000, 0).is_ok());
/// ```
pub fn check_user_cap(
    user_cumulative: u64,
    deposit_amount: u64,
    per_user_cap: u64,
) -> Result<(), CapError> {
    // 0 means unlimited
    if per_user_cap == 0 {
        return Ok(());
    }

    let new_cumulative = user_cumulative
        .checked_add(deposit_amount)
        .ok_or(CapError::MathOverflow)?;

    if new_cumulative > per_user_cap {
        return Err(CapError::UserCapExceeded);
    }

    Ok(())
}

/// Calculate maximum deposit allowed for a user given current state and caps.
///
/// Returns the minimum of:
/// - Global remaining capacity (global_cap - total_assets)
/// - User remaining capacity (per_user_cap - user_cumulative)
///
/// # Arguments
/// * `total_assets` - Current total assets in vault
/// * `user_cumulative` - User's cumulative deposited assets
/// * `global_cap` - Maximum total assets allowed (0 = unlimited)
/// * `per_user_cap` - Maximum assets per user (0 = unlimited)
///
/// # Returns
/// Maximum deposit amount allowed (u64::MAX if no limits)
///
/// # Example
/// ```
/// use svs_caps::max_deposit_for_user;
///
/// // Vault: 500k/1M, User: 30k/100k -> min(500k, 70k) = 70k
/// let max = max_deposit_for_user(500_000, 30_000, 1_000_000, 100_000);
/// assert_eq!(max, 70_000);
///
/// // No caps (0 = unlimited)
/// let max = max_deposit_for_user(500_000, 30_000, 0, 0);
/// assert_eq!(max, u64::MAX);
/// ```
pub fn max_deposit_for_user(
    total_assets: u64,
    user_cumulative: u64,
    global_cap: u64,
    per_user_cap: u64,
) -> u64 {
    let mut max = u64::MAX;

    // Apply global cap limit
    if global_cap > 0 {
        let global_remaining = global_cap.saturating_sub(total_assets);
        max = max.min(global_remaining);
    }

    // Apply per-user cap limit
    if per_user_cap > 0 {
        let user_remaining = per_user_cap.saturating_sub(user_cumulative);
        max = max.min(user_remaining);
    }

    max
}

/// Calculate global cap utilization percentage (0-100).
///
/// # Arguments
/// * `total_assets` - Current total assets in vault
/// * `global_cap` - Maximum total assets allowed (0 = unlimited)
///
/// # Returns
/// Utilization percentage (0-100), 0 if cap is unlimited
pub fn global_utilization_percent(total_assets: u64, global_cap: u64) -> u8 {
    if global_cap == 0 {
        return 0;
    }

    // utilization = (total_assets * 100) / global_cap
    let utilization = ((total_assets as u128) * 100) / (global_cap as u128);
    utilization.min(100) as u8
}

/// Calculate user cap utilization percentage (0-100).
///
/// # Arguments
/// * `user_cumulative` - User's cumulative deposited assets
/// * `per_user_cap` - Maximum assets per user (0 = unlimited)
///
/// # Returns
/// Utilization percentage (0-100), 0 if cap is unlimited
pub fn user_utilization_percent(user_cumulative: u64, per_user_cap: u64) -> u8 {
    if per_user_cap == 0 {
        return 0;
    }

    let utilization = ((user_cumulative as u128) * 100) / (per_user_cap as u128);
    utilization.min(100) as u8
}

/// Validate that per-user cap doesn't exceed global cap.
///
/// # Arguments
/// * `global_cap` - Maximum total assets allowed (0 = unlimited)
/// * `per_user_cap` - Maximum assets per user (0 = unlimited)
///
/// # Returns
/// Ok(()) if valid, Err(UserCapExceedsGlobalCap) if invalid
pub fn validate_cap_config(global_cap: u64, per_user_cap: u64) -> Result<(), CapError> {
    // If both are set, per-user shouldn't exceed global
    if global_cap > 0 && per_user_cap > 0 && per_user_cap > global_cap {
        return Err(CapError::UserCapExceedsGlobalCap);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_global_cap_ok() {
        // Under cap
        assert!(check_global_cap(900_000, 50_000, 1_000_000).is_ok());
        // Exact cap
        assert!(check_global_cap(900_000, 100_000, 1_000_000).is_ok());
    }

    #[test]
    fn test_check_global_cap_exceeded() {
        assert_eq!(
            check_global_cap(900_000, 200_000, 1_000_000),
            Err(CapError::GlobalCapExceeded)
        );
    }

    #[test]
    fn test_check_global_cap_unlimited() {
        // 0 = unlimited
        assert!(check_global_cap(1_000_000_000, 1_000_000_000, 0).is_ok());
    }

    #[test]
    fn test_check_user_cap_ok() {
        assert!(check_user_cap(50_000, 40_000, 100_000).is_ok());
        assert!(check_user_cap(50_000, 50_000, 100_000).is_ok());
    }

    #[test]
    fn test_check_user_cap_exceeded() {
        assert_eq!(
            check_user_cap(50_000, 60_000, 100_000),
            Err(CapError::UserCapExceeded)
        );
    }

    #[test]
    fn test_check_user_cap_unlimited() {
        assert!(check_user_cap(1_000_000_000, 1_000_000_000, 0).is_ok());
    }

    #[test]
    fn test_max_deposit_for_user() {
        // Vault: 500k/1M, User: 30k/100k -> min(500k, 70k) = 70k
        assert_eq!(
            max_deposit_for_user(500_000, 30_000, 1_000_000, 100_000),
            70_000
        );

        // Vault: 900k/1M, User: 30k/100k -> min(100k, 70k) = 70k
        assert_eq!(
            max_deposit_for_user(900_000, 30_000, 1_000_000, 100_000),
            70_000
        );

        // Vault: 500k/1M, User: 90k/100k -> min(500k, 10k) = 10k
        assert_eq!(
            max_deposit_for_user(500_000, 90_000, 1_000_000, 100_000),
            10_000
        );

        // At global cap
        assert_eq!(max_deposit_for_user(1_000_000, 0, 1_000_000, 100_000), 0);

        // At user cap
        assert_eq!(
            max_deposit_for_user(500_000, 100_000, 1_000_000, 100_000),
            0
        );
    }

    #[test]
    fn test_max_deposit_unlimited() {
        // No caps
        assert_eq!(max_deposit_for_user(500_000, 30_000, 0, 0), u64::MAX);

        // Only global cap
        assert_eq!(max_deposit_for_user(500_000, 30_000, 1_000_000, 0), 500_000);

        // Only user cap
        assert_eq!(max_deposit_for_user(500_000, 30_000, 0, 100_000), 70_000);
    }

    #[test]
    fn test_global_utilization_percent() {
        assert_eq!(global_utilization_percent(500_000, 1_000_000), 50);
        assert_eq!(global_utilization_percent(1_000_000, 1_000_000), 100);
        assert_eq!(global_utilization_percent(0, 1_000_000), 0);
        assert_eq!(global_utilization_percent(1_500_000, 1_000_000), 100); // Capped at 100
        assert_eq!(global_utilization_percent(500_000, 0), 0); // Unlimited = 0%
    }

    #[test]
    fn test_user_utilization_percent() {
        assert_eq!(user_utilization_percent(50_000, 100_000), 50);
        assert_eq!(user_utilization_percent(100_000, 100_000), 100);
        assert_eq!(user_utilization_percent(0, 100_000), 0);
        assert_eq!(user_utilization_percent(150_000, 100_000), 100); // Capped at 100
        assert_eq!(user_utilization_percent(50_000, 0), 0); // Unlimited = 0%
    }

    #[test]
    fn test_validate_cap_config() {
        // Valid: user cap <= global cap
        assert!(validate_cap_config(1_000_000, 100_000).is_ok());

        // Valid: equal
        assert!(validate_cap_config(100_000, 100_000).is_ok());

        // Valid: one or both unlimited
        assert!(validate_cap_config(0, 100_000).is_ok());
        assert!(validate_cap_config(1_000_000, 0).is_ok());
        assert!(validate_cap_config(0, 0).is_ok());

        // Invalid: user cap > global cap
        assert_eq!(
            validate_cap_config(100_000, 200_000),
            Err(CapError::UserCapExceedsGlobalCap)
        );
    }

    #[test]
    fn test_overflow_protection() {
        let max = u64::MAX;

        // Addition overflows: (MAX - 100) + 200 > MAX
        assert_eq!(
            check_global_cap(max - 100, 200, max),
            Err(CapError::MathOverflow)
        );

        // Cap exceeded without overflow
        assert_eq!(
            check_global_cap(max - 100, 50, max - 100),
            Err(CapError::GlobalCapExceeded)
        );

        // Unlimited cap (0) skips math entirely - no overflow error
        assert!(check_global_cap(max, 1, 0).is_ok());

        // User cap overflow protection
        assert_eq!(
            check_user_cap(max - 100, 200, max),
            Err(CapError::MathOverflow)
        );

        // Unlimited user cap skips math entirely
        assert!(check_user_cap(max, 1, 0).is_ok());
    }
}
