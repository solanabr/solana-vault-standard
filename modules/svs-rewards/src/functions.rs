//! Core reward calculation functions.
//!
//! Implements MasterChef-style proportional reward distribution:
//! - accumulated_per_share tracks total rewards per share unit
//! - user_debt tracks rewards already accounted for
//! - pending = user_shares * acc_per_share - user_debt

use crate::constants::REWARD_PRECISION;
use crate::error::RewardError;

/// Calculate updated accumulated rewards per share after adding rewards.
///
/// Formula: new_acc = old_acc + (rewards * PRECISION / total_shares)
///
/// # Arguments
/// * `current_acc_per_share` - Current accumulated rewards per share (scaled by PRECISION)
/// * `reward_amount` - New rewards to distribute
/// * `total_shares` - Total shares outstanding
///
/// # Returns
/// Updated accumulated rewards per share
///
/// # Example
/// ```
/// use svs_rewards::{update_accumulated_per_share, REWARD_PRECISION};
///
/// // Add 1000 rewards to vault with 1M shares, starting from 0
/// let new_acc = update_accumulated_per_share(0, 1000, 1_000_000).unwrap();
/// // new_acc = 1000 * 1e18 / 1M = 1e15
/// assert_eq!(new_acc, REWARD_PRECISION / 1000);
/// ```
pub fn update_accumulated_per_share(
    current_acc_per_share: u128,
    reward_amount: u64,
    total_shares: u64,
) -> Result<u128, RewardError> {
    if total_shares == 0 || reward_amount == 0 {
        return Ok(current_acc_per_share);
    }

    // delta = reward_amount * PRECISION / total_shares
    let delta = (reward_amount as u128)
        .checked_mul(REWARD_PRECISION)
        .ok_or(RewardError::MathOverflow)?
        .checked_div(total_shares as u128)
        .ok_or(RewardError::DivisionByZero)?;

    current_acc_per_share
        .checked_add(delta)
        .ok_or(RewardError::MathOverflow)
}

/// Calculate pending rewards for a user.
///
/// Formula: pending = (user_shares * acc_per_share - user_debt) / PRECISION + unclaimed
///
/// Both accumulated and debt are kept scaled until the final division.
///
/// # Arguments
/// * `user_shares` - User's current share balance
/// * `acc_per_share` - Current accumulated rewards per share (scaled by PRECISION)
/// * `user_debt` - User's reward debt (scaled by PRECISION)
/// * `unclaimed` - User's previously unclaimed rewards (unscaled)
///
/// # Returns
/// Total pending rewards (in reward token units)
///
/// # Example
/// ```
/// use svs_rewards::{calculate_pending_rewards, REWARD_PRECISION};
///
/// // User with 100k shares, acc_per_share = 1e15, no debt, no unclaimed
/// let pending = calculate_pending_rewards(
///     100_000,
///     REWARD_PRECISION / 1000,  // 1e15
///     0,
///     0
/// ).unwrap();
/// // pending = 100k * 1e15 / 1e18 = 100
/// assert_eq!(pending, 100);
/// ```
pub fn calculate_pending_rewards(
    user_shares: u64,
    acc_per_share: u128,
    user_debt: u128,
    unclaimed: u64,
) -> Result<u64, RewardError> {
    // Keep everything scaled: accumulated_scaled = user_shares * acc_per_share
    let accumulated_scaled = (user_shares as u128)
        .checked_mul(acc_per_share)
        .ok_or(RewardError::MathOverflow)?;

    // new_rewards_scaled = accumulated_scaled - user_debt (both scaled)
    let new_rewards_scaled = accumulated_scaled.saturating_sub(user_debt);

    // Divide by PRECISION to get actual reward count
    let new_rewards = new_rewards_scaled / REWARD_PRECISION;

    // Add unclaimed (already unscaled)
    let total = new_rewards
        .checked_add(unclaimed as u128)
        .ok_or(RewardError::MathOverflow)?;

    // Cap at u64::MAX
    if total > u64::MAX as u128 {
        Ok(u64::MAX)
    } else {
        Ok(total as u64)
    }
}

/// Calculate new reward debt after deposit/stake.
///
/// Formula: new_debt = user_shares * acc_per_share / PRECISION
///
/// # Arguments
/// * `user_shares` - User's share balance after deposit
/// * `acc_per_share` - Current accumulated rewards per share
///
/// # Returns
/// New reward debt value
pub fn calculate_reward_debt(user_shares: u64, acc_per_share: u128) -> Result<u128, RewardError> {
    (user_shares as u128)
        .checked_mul(acc_per_share)
        .ok_or(RewardError::MathOverflow)?
        .checked_div(REWARD_PRECISION)
        .ok_or(RewardError::DivisionByZero)
        .map(|v| v.checked_mul(REWARD_PRECISION).unwrap_or(u128::MAX))
}

/// Calculate reward debt using scaled value (matches storage format).
///
/// The debt is stored scaled by PRECISION for consistency with acc_per_share.
///
/// # Arguments
/// * `user_shares` - User's share balance
/// * `acc_per_share` - Current accumulated rewards per share (scaled)
///
/// # Returns
/// Scaled reward debt
pub fn calculate_scaled_debt(user_shares: u64, acc_per_share: u128) -> Result<u128, RewardError> {
    (user_shares as u128)
        .checked_mul(acc_per_share)
        .ok_or(RewardError::MathOverflow)
}

/// Update user state on deposit (before shares increase).
///
/// Before increasing shares, we snapshot pending rewards to unclaimed
/// and recalculate debt based on new share count.
///
/// # Arguments
/// * `current_shares` - User's shares before deposit
/// * `deposit_shares` - Shares being added
/// * `acc_per_share` - Current accumulated rewards per share
/// * `current_debt` - User's current reward debt
/// * `current_unclaimed` - User's current unclaimed rewards
///
/// # Returns
/// `(new_debt, new_unclaimed)` - Updated debt and unclaimed values
pub fn on_deposit(
    current_shares: u64,
    deposit_shares: u64,
    acc_per_share: u128,
    current_debt: u128,
    current_unclaimed: u64,
) -> Result<(u128, u64), RewardError> {
    // Calculate pending before deposit
    let pending = calculate_pending_rewards(
        current_shares,
        acc_per_share,
        current_debt,
        current_unclaimed,
    )?;

    // New share count
    let new_shares = current_shares
        .checked_add(deposit_shares)
        .ok_or(RewardError::MathOverflow)?;

    // Calculate new debt based on new share count
    let new_debt = calculate_scaled_debt(new_shares, acc_per_share)?;

    Ok((new_debt, pending))
}

/// Update user state on withdrawal (before shares decrease).
///
/// Before decreasing shares, we snapshot pending rewards to unclaimed
/// and recalculate debt based on new share count.
///
/// # Arguments
/// * `current_shares` - User's shares before withdrawal
/// * `withdraw_shares` - Shares being removed
/// * `acc_per_share` - Current accumulated rewards per share
/// * `current_debt` - User's current reward debt
/// * `current_unclaimed` - User's current unclaimed rewards
///
/// # Returns
/// `(new_debt, new_unclaimed)` - Updated debt and unclaimed values
pub fn on_withdraw(
    current_shares: u64,
    withdraw_shares: u64,
    acc_per_share: u128,
    current_debt: u128,
    current_unclaimed: u64,
) -> Result<(u128, u64), RewardError> {
    // Calculate pending before withdrawal
    let pending = calculate_pending_rewards(
        current_shares,
        acc_per_share,
        current_debt,
        current_unclaimed,
    )?;

    // New share count
    let new_shares = current_shares.saturating_sub(withdraw_shares);

    // Calculate new debt based on new share count
    let new_debt = calculate_scaled_debt(new_shares, acc_per_share)?;

    Ok((new_debt, pending))
}

/// Process a claim and return updated state.
///
/// # Arguments
/// * `user_shares` - User's current share balance
/// * `acc_per_share` - Current accumulated rewards per share
/// * `current_debt` - User's current reward debt
/// * `current_unclaimed` - User's current unclaimed rewards
///
/// # Returns
/// `(claim_amount, new_debt, new_unclaimed)` - Amount to claim and updated state
pub fn on_claim(
    user_shares: u64,
    acc_per_share: u128,
    current_debt: u128,
    current_unclaimed: u64,
) -> Result<(u64, u128, u64), RewardError> {
    let pending =
        calculate_pending_rewards(user_shares, acc_per_share, current_debt, current_unclaimed)?;

    if pending == 0 {
        return Err(RewardError::NothingToClaim);
    }

    // Reset debt to current accumulated
    let new_debt = calculate_scaled_debt(user_shares, acc_per_share)?;

    Ok((pending, new_debt, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_update_accumulated_per_share() {
        // 1000 rewards, 1M shares
        let acc = update_accumulated_per_share(0, 1000, 1_000_000).unwrap();
        assert_eq!(acc, REWARD_PRECISION / 1000);

        // Add more rewards
        let acc2 = update_accumulated_per_share(acc, 1000, 1_000_000).unwrap();
        assert_eq!(acc2, REWARD_PRECISION / 500);
    }

    #[test]
    fn test_update_accumulated_zero_shares() {
        // No shares = no update
        let acc = update_accumulated_per_share(0, 1000, 0).unwrap();
        assert_eq!(acc, 0);
    }

    #[test]
    fn test_update_accumulated_zero_rewards() {
        let acc = update_accumulated_per_share(100, 0, 1_000_000).unwrap();
        assert_eq!(acc, 100);
    }

    #[test]
    fn test_calculate_pending_rewards() {
        // User with 100k shares, 1e15 acc_per_share
        let pending = calculate_pending_rewards(100_000, REWARD_PRECISION / 1000, 0, 0).unwrap();
        assert_eq!(pending, 100);
    }

    #[test]
    fn test_calculate_pending_with_debt() {
        let acc = REWARD_PRECISION / 1000; // 1e15
        let debt = (50_000u128) * acc; // Debt for 50k shares

        // 100k shares but debt for 50k
        let pending = calculate_pending_rewards(100_000, acc, debt, 0).unwrap();
        assert_eq!(pending, 50);
    }

    #[test]
    fn test_calculate_pending_with_unclaimed() {
        let pending = calculate_pending_rewards(100_000, REWARD_PRECISION / 1000, 0, 50).unwrap();
        assert_eq!(pending, 150); // 100 from acc + 50 unclaimed
    }

    #[test]
    fn test_on_deposit() {
        // User deposits 50k shares into pool with 1e15 acc_per_share
        let acc = REWARD_PRECISION / 1000;

        // Initial state: 0 shares, 0 debt, 0 unclaimed
        let (new_debt, new_unclaimed) = on_deposit(0, 50_000, acc, 0, 0).unwrap();

        // Debt should be 50k * acc
        assert_eq!(new_debt, 50_000u128 * acc);
        // No unclaimed (had 0 shares)
        assert_eq!(new_unclaimed, 0);

        // Second deposit: 50k more shares
        let (new_debt2, new_unclaimed2) =
            on_deposit(50_000, 50_000, acc * 2, new_debt, new_unclaimed).unwrap();

        // Should have pending = 50k * (2e15 - 1e15) / 1e18 = 50
        assert_eq!(new_unclaimed2, 50);
        // Debt for 100k shares at 2e15
        assert_eq!(new_debt2, 100_000u128 * acc * 2);
    }

    #[test]
    fn test_on_withdraw() {
        let acc = REWARD_PRECISION / 1000;
        let initial_debt = 100_000u128 * acc;

        // User has 100k shares, withdraws 50k
        let (new_debt, new_unclaimed) =
            on_withdraw(100_000, 50_000, acc * 2, initial_debt, 0).unwrap();

        // Pending before = 100k * 2e15 - 100k * 1e15 = 100
        assert_eq!(new_unclaimed, 100);
        // Debt for 50k shares at 2e15
        assert_eq!(new_debt, 50_000u128 * acc * 2);
    }

    #[test]
    fn test_on_claim() {
        let acc = REWARD_PRECISION / 1000;
        let debt = 50_000u128 * acc;

        // User has 100k shares, acc doubled since deposit
        let (claim, new_debt, new_unclaimed) = on_claim(100_000, acc * 2, debt, 10).unwrap();

        // Pending = 100k * 2e15 - 50k * 1e15 + 10 = 150 + 10 = 160
        assert_eq!(claim, 160);
        // Debt reset to 100k * 2e15
        assert_eq!(new_debt, 100_000u128 * acc * 2);
        // Unclaimed reset to 0
        assert_eq!(new_unclaimed, 0);
    }

    #[test]
    fn test_on_claim_nothing() {
        let acc = REWARD_PRECISION / 1000;
        let debt = 100_000u128 * acc;

        // User at current acc with no unclaimed
        let result = on_claim(100_000, acc, debt, 0);
        assert_eq!(result, Err(RewardError::NothingToClaim));
    }

    #[test]
    fn test_full_scenario() {
        // Scenario: 2 users, rewards added over time

        // Initial: User A deposits 100k shares at acc=0
        let acc_0 = 0u128;
        let (user_a_debt, user_a_unclaimed) = on_deposit(0, 100_000, acc_0, 0, 0).unwrap();
        assert_eq!(user_a_debt, 0);
        assert_eq!(user_a_unclaimed, 0);

        // 1000 rewards added
        let acc_1 = update_accumulated_per_share(acc_0, 1000, 100_000).unwrap();

        // User B deposits 100k shares
        let (user_b_debt, user_b_unclaimed) = on_deposit(0, 100_000, acc_1, 0, 0).unwrap();
        assert_eq!(user_b_debt, 100_000u128 * acc_1);
        assert_eq!(user_b_unclaimed, 0);

        // 1000 more rewards (now split between A and B)
        let acc_2 = update_accumulated_per_share(acc_1, 1000, 200_000).unwrap();

        // User A claims
        let (a_claim, _, _) = on_claim(100_000, acc_2, user_a_debt, user_a_unclaimed).unwrap();
        // A gets all of first 1000 + half of second 1000 = 1500
        assert_eq!(a_claim, 1500);

        // User B claims
        let (b_claim, _, _) = on_claim(100_000, acc_2, user_b_debt, user_b_unclaimed).unwrap();
        // B gets half of second 1000 = 500
        assert_eq!(b_claim, 500);
    }
}
