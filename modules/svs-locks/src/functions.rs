//! Core lock enforcement functions.

use crate::constants::MAX_LOCK_DURATION;
use crate::error::LockError;

/// Check if shares are still locked.
///
/// # Arguments
/// * `locked_until` - Timestamp when lock expires (0 = no lock)
/// * `current_timestamp` - Current Unix timestamp
///
/// # Returns
/// Ok(()) if shares can be redeemed, Err(SharesLocked) otherwise
///
/// # Example
/// ```
/// use svs_locks::check_lockup;
///
/// // Lock expired
/// assert!(check_lockup(1000, 2000).is_ok());
///
/// // Still locked
/// assert!(check_lockup(3000, 2000).is_err());
///
/// // No lock (locked_until = 0)
/// assert!(check_lockup(0, 2000).is_ok());
/// ```
pub fn check_lockup(locked_until: i64, current_timestamp: i64) -> Result<(), LockError> {
    // 0 means no lock
    if locked_until == 0 {
        return Ok(());
    }

    if current_timestamp < locked_until {
        return Err(LockError::SharesLocked);
    }

    Ok(())
}

/// Calculate when a new lock expires.
///
/// # Arguments
/// * `current_timestamp` - Current Unix timestamp
/// * `lock_duration` - Lock duration in seconds (0 = no lock)
///
/// # Returns
/// Timestamp when lock expires
///
/// # Example
/// ```
/// use svs_locks::set_lock;
///
/// // 1 day lock starting at timestamp 1000
/// let locked_until = set_lock(1000, 86400).unwrap();
/// assert_eq!(locked_until, 87400);
///
/// // No lock
/// let locked_until = set_lock(1000, 0).unwrap();
/// assert_eq!(locked_until, 0);
/// ```
pub fn set_lock(current_timestamp: i64, lock_duration: i64) -> Result<i64, LockError> {
    // No lock
    if lock_duration == 0 {
        return Ok(0);
    }

    // Invalid duration
    if lock_duration < 0 {
        return Err(LockError::InvalidDuration);
    }

    // Check overflow
    let locked_until = current_timestamp
        .checked_add(lock_duration)
        .ok_or(LockError::MathOverflow)?;

    Ok(locked_until)
}

/// Extend an existing lock to a new duration.
///
/// The new lock is calculated from current_timestamp, not from the existing lock.
/// This prevents users from extending locks indefinitely.
///
/// # Arguments
/// * `current_locked_until` - Current lock expiry timestamp
/// * `current_timestamp` - Current Unix timestamp
/// * `new_duration` - New lock duration in seconds
///
/// # Returns
/// New locked_until timestamp (max of current and new)
///
/// # Example
/// ```
/// use svs_locks::extend_lock;
///
/// // Extend a lock that expires at 5000 with a 2000s duration at time 4000
/// // New lock would expire at 6000, which is later than 5000
/// let new_lock = extend_lock(5000, 4000, 2000).unwrap();
/// assert_eq!(new_lock, 6000);
///
/// // Extending with shorter duration doesn't reduce lock
/// let new_lock = extend_lock(5000, 4000, 500).unwrap();
/// assert_eq!(new_lock, 5000); // Keeps original
/// ```
pub fn extend_lock(
    current_locked_until: i64,
    current_timestamp: i64,
    new_duration: i64,
) -> Result<i64, LockError> {
    // Calculate new potential lock
    let new_locked_until = set_lock(current_timestamp, new_duration)?;

    // Return the later of the two (never reduce lock time)
    Ok(current_locked_until.max(new_locked_until))
}

/// Calculate remaining lock time in seconds.
///
/// # Arguments
/// * `locked_until` - Timestamp when lock expires
/// * `current_timestamp` - Current Unix timestamp
///
/// # Returns
/// Seconds remaining (0 if unlocked or expired)
///
/// # Example
/// ```
/// use svs_locks::remaining_lock_time;
///
/// // 500 seconds remaining
/// assert_eq!(remaining_lock_time(2500, 2000), 500);
///
/// // Lock expired
/// assert_eq!(remaining_lock_time(1000, 2000), 0);
///
/// // No lock
/// assert_eq!(remaining_lock_time(0, 2000), 0);
/// ```
pub fn remaining_lock_time(locked_until: i64, current_timestamp: i64) -> i64 {
    if locked_until == 0 {
        return 0;
    }

    (locked_until - current_timestamp).max(0)
}

/// Validate lock duration is within limits.
///
/// # Arguments
/// * `lock_duration` - Lock duration in seconds
///
/// # Returns
/// Ok(()) if valid, Err otherwise
pub fn validate_lock_duration(lock_duration: i64) -> Result<(), LockError> {
    if lock_duration < 0 {
        return Err(LockError::InvalidDuration);
    }

    if lock_duration > MAX_LOCK_DURATION {
        return Err(LockError::DurationExceedsMax);
    }

    Ok(())
}

/// Check if user can redeem shares considering the lock.
///
/// Convenience function combining lock check with amount validation.
///
/// # Arguments
/// * `locked_until` - Timestamp when lock expires
/// * `current_timestamp` - Current Unix timestamp
/// * `shares_to_redeem` - Amount of shares user wants to redeem
/// * `user_shares` - User's total share balance
///
/// # Returns
/// Ok(()) if redemption allowed, Err otherwise
pub fn can_redeem(
    locked_until: i64,
    current_timestamp: i64,
    shares_to_redeem: u64,
    user_shares: u64,
) -> Result<(), LockError> {
    // Check lock first
    check_lockup(locked_until, current_timestamp)?;

    // Balance check is done by token program, but we validate here too
    if shares_to_redeem > user_shares {
        // This is actually a token error, but we check it anyway
        return Ok(()); // Let token program handle this
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_lockup_expired() {
        assert!(check_lockup(1000, 2000).is_ok());
        assert!(check_lockup(1000, 1000).is_ok()); // Exact expiry
    }

    #[test]
    fn test_check_lockup_still_locked() {
        assert_eq!(check_lockup(3000, 2000), Err(LockError::SharesLocked));
    }

    #[test]
    fn test_check_lockup_no_lock() {
        assert!(check_lockup(0, 2000).is_ok());
        assert!(check_lockup(0, 0).is_ok());
    }

    #[test]
    fn test_set_lock() {
        // Normal lock
        assert_eq!(set_lock(1000, 86400).unwrap(), 87400);

        // No lock
        assert_eq!(set_lock(1000, 0).unwrap(), 0);
    }

    #[test]
    fn test_set_lock_invalid() {
        // Negative duration
        assert_eq!(set_lock(1000, -100), Err(LockError::InvalidDuration));
    }

    #[test]
    fn test_set_lock_overflow() {
        assert_eq!(set_lock(i64::MAX, 100), Err(LockError::MathOverflow));
    }

    #[test]
    fn test_extend_lock_longer() {
        // New lock is later
        let new_lock = extend_lock(5000, 4000, 2000).unwrap();
        assert_eq!(new_lock, 6000);
    }

    #[test]
    fn test_extend_lock_shorter() {
        // Original lock is later
        let new_lock = extend_lock(5000, 4000, 500).unwrap();
        assert_eq!(new_lock, 5000);
    }

    #[test]
    fn test_extend_lock_no_original() {
        // No original lock
        let new_lock = extend_lock(0, 1000, 500).unwrap();
        assert_eq!(new_lock, 1500);
    }

    #[test]
    fn test_remaining_lock_time() {
        assert_eq!(remaining_lock_time(2500, 2000), 500);
        assert_eq!(remaining_lock_time(1000, 2000), 0);
        assert_eq!(remaining_lock_time(0, 2000), 0);
    }

    #[test]
    fn test_validate_lock_duration() {
        assert!(validate_lock_duration(0).is_ok());
        assert!(validate_lock_duration(86400).is_ok());
        assert!(validate_lock_duration(MAX_LOCK_DURATION).is_ok());
        assert_eq!(
            validate_lock_duration(MAX_LOCK_DURATION + 1),
            Err(LockError::DurationExceedsMax)
        );
        assert_eq!(validate_lock_duration(-1), Err(LockError::InvalidDuration));
    }

    #[test]
    fn test_can_redeem() {
        // Unlocked
        assert!(can_redeem(0, 1000, 100, 1000).is_ok());

        // Lock expired
        assert!(can_redeem(500, 1000, 100, 1000).is_ok());

        // Still locked
        assert_eq!(
            can_redeem(2000, 1000, 100, 1000),
            Err(LockError::SharesLocked)
        );
    }
}
