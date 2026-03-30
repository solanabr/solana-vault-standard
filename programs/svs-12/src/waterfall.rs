use anchor_lang::prelude::*;

use crate::error::TranchedVaultError;

/// Distribute yield sequentially: senior gets target yield first, residual flows to junior.
///
/// Tranches MUST be sorted by priority ascending (0 = senior first).
pub fn distribute_yield_sequential(
    total_yield: u64,
    allocations: &[u64],
    target_yield_bps: &[u16],
) -> Result<Vec<u64>> {
    let n = allocations.len();
    let mut distribution = vec![0u64; n];
    let mut remaining = total_yield;

    for i in 0..n {
        if remaining == 0 {
            break;
        }
        if target_yield_bps[i] == 0 {
            distribution[i] = remaining;
            remaining = 0;
            break;
        }
        let entitled = (allocations[i] as u128)
            .checked_mul(target_yield_bps[i] as u128)
            .ok_or(TranchedVaultError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(TranchedVaultError::MathOverflow)? as u64;
        let actual = remaining.min(entitled);
        distribution[i] = actual;
        remaining = remaining
            .checked_sub(actual)
            .ok_or(TranchedVaultError::MathOverflow)?;
    }

    // Residual to last tranche (equity)
    if remaining > 0 {
        distribution[n - 1] = distribution[n - 1]
            .checked_add(remaining)
            .ok_or(TranchedVaultError::MathOverflow)?;
    }

    Ok(distribution)
}

/// Distribute yield pro-rata by allocation share. Rounding dust goes to last tranche.
pub fn distribute_yield_prorata(total_yield: u64, allocations: &[u64]) -> Result<Vec<u64>> {
    let n = allocations.len();
    let mut distribution = vec![0u64; n];
    let total_principal: u64 = allocations
        .iter()
        .try_fold(0u64, |acc, &a| acc.checked_add(a))
        .ok_or(TranchedVaultError::MathOverflow)?;

    if total_principal == 0 {
        return Ok(distribution);
    }

    let mut distributed: u64 = 0;
    for i in 0..n {
        let share = (total_yield as u128)
            .checked_mul(allocations[i] as u128)
            .ok_or(TranchedVaultError::MathOverflow)?
            .checked_div(total_principal as u128)
            .ok_or(TranchedVaultError::MathOverflow)? as u64;
        distribution[i] = share;
        distributed = distributed
            .checked_add(share)
            .ok_or(TranchedVaultError::MathOverflow)?;
    }

    // Rounding dust to last tranche
    let dust = total_yield
        .checked_sub(distributed)
        .ok_or(TranchedVaultError::MathOverflow)?;
    if dust > 0 {
        distribution[n - 1] = distribution[n - 1]
            .checked_add(dust)
            .ok_or(TranchedVaultError::MathOverflow)?;
    }

    Ok(distribution)
}

/// Absorb losses bottom-up: junior absorbs first, senior last.
///
/// Tranches MUST be sorted by priority ascending (senior first).
/// Iteration goes from last (junior) to first (senior).
pub fn absorb_losses(total_loss: u64, allocations: &mut [u64]) -> Result<Vec<u64>> {
    let n = allocations.len();
    let mut absorbed = vec![0u64; n];
    let mut remaining = total_loss;

    // Iterate junior → senior (reverse order)
    for i in (0..n).rev() {
        if remaining == 0 {
            break;
        }
        let loss = remaining.min(allocations[i]);
        absorbed[i] = loss;
        allocations[i] = allocations[i]
            .checked_sub(loss)
            .ok_or(TranchedVaultError::MathOverflow)?;
        remaining = remaining
            .checked_sub(loss)
            .ok_or(TranchedVaultError::MathOverflow)?;
    }

    require!(remaining == 0, TranchedVaultError::TotalLoss);

    Ok(absorbed)
}

/// Check subordination ratios for all tranches.
///
/// For each tranche i, the sum of assets in lower-priority tranches must be
/// >= total_assets * tranche.subordination_bps / 10_000 (ceiling).
///
/// Tranches MUST be sorted by priority ascending (senior first).
pub fn check_subordination(
    allocations: &[u64],
    subordination_bps: &[u16],
    total_assets: u64,
) -> Result<()> {
    let n = allocations.len();

    for i in 0..n {
        if subordination_bps[i] == 0 {
            continue;
        }

        // Sum assets of all tranches with higher index (lower priority / more junior)
        let junior_assets: u64 = allocations[i + 1..]
            .iter()
            .try_fold(0u64, |acc, &a| acc.checked_add(a))
            .ok_or(TranchedVaultError::MathOverflow)?;

        // Required subordination (ceiling division)
        let numerator = (total_assets as u128)
            .checked_mul(subordination_bps[i] as u128)
            .ok_or(TranchedVaultError::MathOverflow)?;
        let required = numerator
            .checked_add(9_999)
            .ok_or(TranchedVaultError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(TranchedVaultError::MathOverflow)? as u64;

        require!(
            junior_assets >= required,
            TranchedVaultError::SubordinationBreach
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ======================== Sequential Yield Distribution ========================

    #[test]
    fn sequential_senior_gets_entitled_junior_gets_residual() {
        // Senior: 1000 allocated, 500 bps (5%) target = 50 entitled
        // Junior: 500 allocated, 0 bps (equity) = gets remainder
        let allocs = &[1000, 500];
        let targets = &[500, 0];

        let dist = distribute_yield_sequential(80, allocs, targets).unwrap();
        assert_eq!(dist, vec![50, 30]); // senior: min(80, 50)=50, junior: 30
    }

    #[test]
    fn sequential_insufficient_yield_for_senior() {
        let allocs = &[1000, 500];
        let targets = &[500, 0]; // senior entitled 50

        let dist = distribute_yield_sequential(30, allocs, targets).unwrap();
        assert_eq!(dist, vec![30, 0]); // senior gets all 30, junior gets nothing
    }

    #[test]
    fn sequential_three_tranches() {
        // Senior: 1000, 300 bps (3%) = 30 entitled
        // Mezz: 500, 600 bps (6%) = 30 entitled
        // Junior: 200, 0 bps (equity)
        let allocs = &[1000, 500, 200];
        let targets = &[300, 600, 0];

        let dist = distribute_yield_sequential(100, allocs, targets).unwrap();
        assert_eq!(dist, vec![30, 30, 40]); // 30+30+40=100
    }

    #[test]
    fn sequential_zero_yield() {
        let allocs = &[1000, 500];
        let targets = &[500, 0];

        let dist = distribute_yield_sequential(0, allocs, targets).unwrap();
        assert_eq!(dist, vec![0, 0]);
    }

    #[test]
    fn sequential_single_tranche() {
        let allocs = &[1000];
        let targets = &[500];

        let dist = distribute_yield_sequential(100, allocs, targets).unwrap();
        assert_eq!(dist, vec![100]); // all goes to single tranche (capped then residual)
    }

    // ======================== Pro-Rata Yield Distribution ========================

    #[test]
    fn prorata_proportional_split() {
        // 60/40 split
        let allocs = &[600, 400];
        let dist = distribute_yield_prorata(100, allocs).unwrap();
        assert_eq!(dist, vec![60, 40]);
    }

    #[test]
    fn prorata_dust_to_last() {
        // 1/3 each - can't split 100 evenly by 3
        let allocs = &[100, 100, 100];
        let dist = distribute_yield_prorata(100, allocs).unwrap();
        // 100*100/300 = 33 each, dust = 100 - 99 = 1 → last tranche
        assert_eq!(dist, vec![33, 33, 34]);
    }

    #[test]
    fn prorata_zero_total_principal() {
        let allocs = &[0, 0];
        let dist = distribute_yield_prorata(100, allocs).unwrap();
        assert_eq!(dist, vec![0, 0]);
    }

    #[test]
    fn prorata_single_tranche() {
        let allocs = &[500];
        let dist = distribute_yield_prorata(100, allocs).unwrap();
        assert_eq!(dist, vec![100]);
    }

    // ======================== Loss Absorption ========================

    #[test]
    fn loss_junior_absorbs_first() {
        // sorted ascending: [senior=1000, junior=500]
        let mut allocs = vec![1000, 500];
        let absorbed = absorb_losses(200, &mut allocs).unwrap();
        assert_eq!(absorbed, vec![0, 200]); // junior absorbs all
        assert_eq!(allocs, vec![1000, 300]); // junior reduced
    }

    #[test]
    fn loss_spills_to_senior() {
        let mut allocs = vec![1000, 500];
        let absorbed = absorb_losses(700, &mut allocs).unwrap();
        assert_eq!(absorbed, vec![200, 500]); // junior: 500, senior: 200
        assert_eq!(allocs, vec![800, 0]);
    }

    #[test]
    fn loss_total_wipe() {
        let mut allocs = vec![1000, 500];
        let absorbed = absorb_losses(1500, &mut allocs).unwrap();
        assert_eq!(absorbed, vec![1000, 500]);
        assert_eq!(allocs, vec![0, 0]);
    }

    #[test]
    fn loss_exceeds_total_assets() {
        let mut allocs = vec![1000, 500];
        let result = absorb_losses(2000, &mut allocs);
        assert!(result.is_err()); // TotalLoss
    }

    #[test]
    fn loss_three_tranches_bottom_up() {
        // [senior=500, mezz=300, junior=200]
        let mut allocs = vec![500, 300, 200];
        let absorbed = absorb_losses(400, &mut allocs).unwrap();
        // junior absorbs 200, mezz absorbs 200
        assert_eq!(absorbed, vec![0, 200, 200]);
        assert_eq!(allocs, vec![500, 100, 0]);
    }

    #[test]
    fn loss_zero_amount() {
        let mut allocs = vec![1000, 500];
        let absorbed = absorb_losses(0, &mut allocs).unwrap();
        assert_eq!(absorbed, vec![0, 0]);
        assert_eq!(allocs, vec![1000, 500]);
    }

    // ======================== Subordination ========================

    #[test]
    fn subordination_valid() {
        // Senior requires 20% subordination: junior must be >= 20% of total
        // Total = 1000 + 500 = 1500, 20% of 1500 = 300. Junior = 500 >= 300 ✓
        let allocs = &[1000, 500];
        let sub_bps = &[2000, 0]; // senior: 20%, junior: 0%
        assert!(check_subordination(allocs, sub_bps, 1500).is_ok());
    }

    #[test]
    fn subordination_breach() {
        // Senior requires 50% subordination: junior must be >= 750
        // But junior only has 500
        let allocs = &[1000, 500];
        let sub_bps = &[5000, 0];
        assert!(check_subordination(allocs, sub_bps, 1500).is_err());
    }

    #[test]
    fn subordination_zero_bps_skipped() {
        // No subordination requirement
        let allocs = &[1000, 500];
        let sub_bps = &[0, 0];
        assert!(check_subordination(allocs, sub_bps, 1500).is_ok());
    }

    #[test]
    fn subordination_three_tranches() {
        // Senior: 30% sub, Mezz: 10% sub, Junior: 0%
        // Total = 600 + 300 + 100 = 1000
        // Senior: junior_assets = 300+100=400 >= ceil(1000*30%)=300 ✓
        // Mezz: junior_assets = 100 >= ceil(1000*10%)=100 ✓
        let allocs = &[600, 300, 100];
        let sub_bps = &[3000, 1000, 0];
        assert!(check_subordination(allocs, sub_bps, 1000).is_ok());
    }

    #[test]
    fn subordination_three_tranches_mezz_breach() {
        // Mezz requires 20% sub: junior must be >= 200. Junior only has 100
        let allocs = &[600, 300, 100];
        let sub_bps = &[3000, 2000, 0];
        assert!(check_subordination(allocs, sub_bps, 1000).is_err());
    }

    #[test]
    fn subordination_ceiling_division() {
        // total=101, bps=5000 => required = ceil(101*5000/10000) = ceil(50.5) = 51
        let allocs = &[50, 51];
        let sub_bps = &[5000, 0];
        assert!(check_subordination(allocs, sub_bps, 101).is_ok());

        // Junior=50 < 51: should breach
        let allocs = &[51, 50];
        assert!(check_subordination(allocs, sub_bps, 101).is_err());
    }

    // ======================== Sort Direction Verification ========================

    #[test]
    fn sequential_with_non_trivial_priority_ordering() {
        // Priorities [0, 2, 1] — must be sorted to [0, 1, 2] before calling
        // Here we simulate that the caller already sorted by priority:
        // priority 0 (senior): 1000 alloc, 500 bps target (5%) = 50
        // priority 1 (mezz): 300 alloc, 300 bps target (3%) = 9
        // priority 2 (junior): 200 alloc, 0 bps (equity) = remainder
        let allocs = &[1000, 300, 200]; // sorted by priority asc
        let targets = &[500, 300, 0];

        let dist = distribute_yield_sequential(100, allocs, targets).unwrap();
        assert_eq!(dist, vec![50, 9, 41]); // 50+9+41=100
    }

    #[test]
    fn loss_absorption_reverse_of_priority_order() {
        // Sorted ascending: [senior(p=0)=500, mezz(p=1)=300, junior(p=2)=200]
        // Loss absorbs from index 2 → 1 → 0 (reverse = junior first)
        let mut allocs = vec![500, 300, 200];
        let absorbed = absorb_losses(250, &mut allocs).unwrap();
        assert_eq!(absorbed, vec![0, 50, 200]); // junior: 200, mezz: 50
        assert_eq!(allocs, vec![500, 250, 0]);
    }
}
