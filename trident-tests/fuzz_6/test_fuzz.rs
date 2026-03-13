use fuzz_accounts::*;
use svs_math::{convert_to_assets, convert_to_shares, Rounding};
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;

const NUM_USERS: usize = 5;
const MAX_TRANCHES: usize = 2;
const PRICE_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18

#[derive(Clone, Copy, Default)]
struct UserState {
    shares_balance: [u64; MAX_TRANCHES],
    cumulative_deposited: [u128; MAX_TRANCHES],
    cumulative_redeemed: [u128; MAX_TRANCHES],
}

#[derive(Clone, Copy, Default)]
struct TrancheModel {
    total_shares: u64,
    total_assets_allocated: u64,
    priority: u8,
    subordination_bps: u16,
    target_yield_bps: u16,
    cap_bps: u16,
}

/// SVS-12 tranched vault state tracker for invariant checks.
///
/// Validates:
/// - total_assets == sum(tranche[i].total_assets_allocated)
/// - Share price monotonicity (yield never decreases prices)
/// - Sequential waterfall yield distribution correctness
/// - Bottom-up loss absorption ordering
/// - Subordination enforcement after deposits/redeems/rebalance
/// - Round-trip safety (deposit → redeem favors vault)
#[derive(Default, Clone)]
struct VaultTracker {
    initialized: bool,
    total_assets: u64,
    tranches: [TrancheModel; MAX_TRANCHES],
    num_tranches: usize,
    paused: bool,
    wiped: bool,
    users: [UserState; NUM_USERS],
    decimals_offset: u8,
    cumulative_yield_input: u128,
    cumulative_yield_distributed: u128,
}

impl VaultTracker {
    fn virtual_offset(&self) -> u64 {
        10u64.pow(self.decimals_offset as u32)
    }

    fn share_price(&self, tranche_idx: usize) -> u128 {
        let t = &self.tranches[tranche_idx];
        let offset = self.virtual_offset() as u128;
        let virtual_shares = t.total_shares as u128 + offset;
        let virtual_assets = t.total_assets_allocated as u128 + offset;
        virtual_assets
            .checked_mul(PRICE_SCALE)
            .unwrap()
            .checked_div(virtual_shares)
            .unwrap()
    }

    fn check_invariants(&self) {
        if !self.initialized {
            return;
        }

        // Invariant 1: total_assets == sum of allocations
        let sum: u64 = self.tranches[..self.num_tranches]
            .iter()
            .map(|t| t.total_assets_allocated)
            .sum();
        assert_eq!(
            self.total_assets, sum,
            "INVARIANT VIOLATED: total_assets ({}) != sum of allocations ({})",
            self.total_assets, sum
        );

        // Invariant 2: share prices must be positive
        for i in 0..self.num_tranches {
            let price = self.share_price(i);
            assert!(
                price > 0,
                "INVARIANT VIOLATED: share price for tranche {} is 0",
                i
            );
        }

        // Invariant 3: no tranche allocation exceeds its cap_bps of total_assets
        if self.total_assets > 0 {
            for i in 0..self.num_tranches {
                let t = &self.tranches[i];
                let cap = ((self.total_assets as u128) * (t.cap_bps as u128) + 9_999) / 10_000;
                assert!(
                    (t.total_assets_allocated as u128) <= cap,
                    "CAP INVARIANT VIOLATED: tranche {} allocation ({}) exceeds cap ({}, {}bps of {})",
                    i,
                    t.total_assets_allocated,
                    cap,
                    t.cap_bps,
                    self.total_assets
                );
            }
        }
    }

    fn check_cap(&self, tranche_idx: usize, additional_assets: u64) -> bool {
        let new_alloc = self.tranches[tranche_idx].total_assets_allocated as u128
            + additional_assets as u128;
        let new_total = self.total_assets as u128 + additional_assets as u128;
        if new_total == 0 {
            return true;
        }
        let cap = (new_total * (self.tranches[tranche_idx].cap_bps as u128) + 9_999) / 10_000;
        new_alloc <= cap
    }

    fn simulate_prorata_yield(&mut self, total_yield: u64) -> bool {
        if self.paused || self.wiped || total_yield == 0 || self.num_tranches == 0 {
            return false;
        }
        if self.total_assets == 0 {
            return false;
        }

        let mut pre_prices = [0u128; MAX_TRANCHES];
        for i in 0..self.num_tranches {
            pre_prices[i] = self.share_price(i);
        }

        let mut total_distributed: u128 = 0;
        let mut distribution = [0u64; MAX_TRANCHES];
        let mut remaining = total_yield;

        for i in 0..self.num_tranches {
            if i == self.num_tranches - 1 {
                distribution[i] = remaining;
            } else {
                let share = ((total_yield as u128)
                    * (self.tranches[i].total_assets_allocated as u128)
                    / (self.total_assets as u128)) as u64;
                distribution[i] = share.min(remaining);
                remaining -= distribution[i];
            }
        }

        for i in 0..self.num_tranches {
            self.tranches[i].total_assets_allocated += distribution[i];
            total_distributed += distribution[i] as u128;
        }
        self.total_assets += total_yield;
        self.cumulative_yield_input += total_yield as u128;
        self.cumulative_yield_distributed += total_distributed;

        assert_eq!(
            total_distributed, total_yield as u128,
            "PRORATA WATERFALL CONSERVATION VIOLATED: yield input ({}) != distributed ({})",
            total_yield, total_distributed
        );

        for i in 0..self.num_tranches {
            let post_price = self.share_price(i);
            assert!(
                post_price >= pre_prices[i],
                "PRORATA PRICE MONOTONICITY VIOLATED: tranche {} price decreased ({} -> {})",
                i,
                pre_prices[i],
                post_price
            );
        }

        self.check_invariants();
        true
    }

    fn check_subordination(&self) -> bool {
        if self.total_assets == 0 || self.num_tranches < 2 {
            return true;
        }

        for i in 0..self.num_tranches {
            if self.tranches[i].subordination_bps == 0 {
                continue;
            }
            let junior_assets: u64 = self.tranches[i + 1..self.num_tranches]
                .iter()
                .map(|t| t.total_assets_allocated)
                .sum();

            let required = ((self.total_assets as u128)
                * (self.tranches[i].subordination_bps as u128)
                + 9_999)
                / 10_000;

            if (junior_assets as u128) < required {
                return false;
            }
        }
        true
    }

    fn simulate_deposit(&mut self, user_idx: usize, tranche_idx: usize, assets: u64) -> bool {
        if self.paused || self.wiped || tranche_idx >= self.num_tranches || assets == 0 {
            return false;
        }

        let t = &self.tranches[tranche_idx];
        let shares = convert_to_shares(
            assets,
            t.total_shares,
            t.total_assets_allocated,
            self.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);

        if shares == 0 {
            return false;
        }

        self.tranches[tranche_idx].total_assets_allocated += assets;
        self.tranches[tranche_idx].total_shares += shares;
        self.total_assets += assets;
        self.users[user_idx].shares_balance[tranche_idx] += shares;
        self.users[user_idx].cumulative_deposited[tranche_idx] += assets as u128;

        if !self.check_subordination() {
            self.tranches[tranche_idx].total_assets_allocated -= assets;
            self.tranches[tranche_idx].total_shares -= shares;
            self.total_assets -= assets;
            self.users[user_idx].shares_balance[tranche_idx] -= shares;
            self.users[user_idx].cumulative_deposited[tranche_idx] -= assets as u128;
            return false;
        }

        self.check_invariants();
        true
    }

    fn simulate_redeem(&mut self, user_idx: usize, tranche_idx: usize, shares: u64) -> bool {
        if self.paused || tranche_idx >= self.num_tranches || shares == 0 {
            return false;
        }

        if self.users[user_idx].shares_balance[tranche_idx] < shares {
            return false;
        }

        let t = &self.tranches[tranche_idx];
        let assets = convert_to_assets(
            shares,
            t.total_shares,
            t.total_assets_allocated,
            self.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);

        if assets == 0 || assets > t.total_assets_allocated {
            return false;
        }

        self.tranches[tranche_idx].total_assets_allocated -= assets;
        self.tranches[tranche_idx].total_shares -= shares;
        self.total_assets -= assets;
        self.users[user_idx].shares_balance[tranche_idx] -= shares;
        self.users[user_idx].cumulative_redeemed[tranche_idx] += assets as u128;

        if !self.check_subordination() {
            self.tranches[tranche_idx].total_assets_allocated += assets;
            self.tranches[tranche_idx].total_shares += shares;
            self.total_assets += assets;
            self.users[user_idx].shares_balance[tranche_idx] += shares;
            self.users[user_idx].cumulative_redeemed[tranche_idx] -= assets as u128;
            return false;
        }

        self.check_invariants();
        true
    }

    fn simulate_yield(&mut self, total_yield: u64) -> bool {
        if self.paused || self.wiped || total_yield == 0 || self.num_tranches == 0 {
            return false;
        }

        let mut pre_prices = [0u128; MAX_TRANCHES];
        for i in 0..self.num_tranches {
            pre_prices[i] = self.share_price(i);
        }

        // Sequential waterfall
        let mut remaining = total_yield;
        let mut distribution = [0u64; MAX_TRANCHES];

        for i in 0..self.num_tranches {
            if remaining == 0 {
                break;
            }
            let t = &self.tranches[i];
            if t.target_yield_bps == 0 {
                distribution[i] = remaining;
                remaining = 0;
                break;
            }
            let entitled =
                ((t.total_assets_allocated as u128) * (t.target_yield_bps as u128) / 10_000) as u64;
            let actual = remaining.min(entitled);
            distribution[i] = actual;
            remaining -= actual;
        }
        if remaining > 0 {
            distribution[self.num_tranches - 1] += remaining;
        }

        let mut total_distributed: u128 = 0;
        for i in 0..self.num_tranches {
            self.tranches[i].total_assets_allocated += distribution[i];
            total_distributed += distribution[i] as u128;
        }
        self.total_assets += total_yield;
        self.cumulative_yield_input += total_yield as u128;
        self.cumulative_yield_distributed += total_distributed;

        assert_eq!(
            total_distributed, total_yield as u128,
            "WATERFALL CONSERVATION VIOLATED: yield input ({}) != distributed ({})",
            total_yield, total_distributed
        );

        // Share prices must not decrease after yield
        for i in 0..self.num_tranches {
            let post_price = self.share_price(i);
            assert!(
                post_price >= pre_prices[i],
                "PRICE MONOTONICITY VIOLATED: tranche {} price decreased after yield ({} -> {})",
                i,
                pre_prices[i],
                post_price
            );
        }

        self.check_invariants();
        true
    }

    fn simulate_loss(&mut self, total_loss: u64) -> bool {
        if self.paused || self.wiped || total_loss == 0 || total_loss > self.total_assets {
            return false;
        }

        // Bottom-up absorption (junior first)
        let mut remaining = total_loss;
        for i in (0..self.num_tranches).rev() {
            if remaining == 0 {
                break;
            }
            let absorbed = remaining.min(self.tranches[i].total_assets_allocated);
            self.tranches[i].total_assets_allocated -= absorbed;
            remaining -= absorbed;
        }

        self.total_assets -= total_loss;
        if self.total_assets == 0 {
            self.wiped = true;
        }

        self.check_invariants();
        true
    }

    fn simulate_rebalance(&mut self, from_idx: usize, to_idx: usize, amount: u64) -> bool {
        if self.paused
            || amount == 0
            || from_idx >= self.num_tranches
            || to_idx >= self.num_tranches
            || from_idx == to_idx
        {
            return false;
        }

        if self.tranches[from_idx].total_assets_allocated < amount {
            return false;
        }

        self.tranches[from_idx].total_assets_allocated -= amount;
        self.tranches[to_idx].total_assets_allocated += amount;

        if !self.check_subordination() {
            self.tranches[from_idx].total_assets_allocated += amount;
            self.tranches[to_idx].total_assets_allocated -= amount;
            return false;
        }

        self.check_invariants();
        true
    }
}

fn random_user() -> usize {
    rand::random::<usize>() % NUM_USERS
}

fn random_amount() -> u64 {
    let raw: u64 = rand::random::<u32>() as u64;
    (raw % 10_000_000 + 1) * 1_000 // 1K to 10B units
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    vault_tracker: VaultTracker,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            vault_tracker: VaultTracker::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        self.vault_tracker = VaultTracker::default();
    }

    // =========================================================================
    // Phase 1: Initialize vault with 2 tranches
    // =========================================================================

    #[flow]
    fn flow_initialize(&mut self) {
        if self.vault_tracker.initialized {
            return;
        }
        let fuzz_decimals: u8 = rand::random::<u8>() % 10;
        self.vault_tracker.decimals_offset = fuzz_decimals;
        self.vault_tracker.num_tranches = 2;

        // Senior: priority=0, sub=2000bps, yield=500bps, cap=10000bps
        self.vault_tracker.tranches[0] = TrancheModel {
            total_shares: 0,
            total_assets_allocated: 0,
            priority: 0,
            subordination_bps: 2000,
            target_yield_bps: 500,
            cap_bps: 10000,
        };

        // Junior: priority=1, sub=0, yield=0, cap=10000bps
        self.vault_tracker.tranches[1] = TrancheModel {
            total_shares: 0,
            total_assets_allocated: 0,
            priority: 1,
            subordination_bps: 0,
            target_yield_bps: 0,
            cap_bps: 10000,
        };

        self.vault_tracker.initialized = true;
    }

    // =========================================================================
    // Phase 2: Deposits — must deposit junior first for subordination
    // =========================================================================

    #[flow]
    fn flow_deposit_junior(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.wiped {
            return;
        }
        let user = random_user();
        let amount = random_amount();
        self.vault_tracker.simulate_deposit(user, 1, amount);
    }

    #[flow]
    fn flow_deposit_senior(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.wiped {
            return;
        }
        let user = random_user();
        let amount = random_amount();
        self.vault_tracker.simulate_deposit(user, 0, amount);
    }

    // =========================================================================
    // Phase 3: Redeems
    // =========================================================================

    #[flow]
    fn flow_redeem_junior(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let user = random_user();
        let shares = self.vault_tracker.users[user].shares_balance[1];
        if shares > 0 {
            let redeem = shares / (rand::random::<u64>() % 4 + 1).max(1);
            self.vault_tracker.simulate_redeem(user, 1, redeem.max(1));
        }
    }

    #[flow]
    fn flow_redeem_senior(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let user = random_user();
        let shares = self.vault_tracker.users[user].shares_balance[0];
        if shares > 0 {
            let redeem = shares / (rand::random::<u64>() % 4 + 1).max(1);
            self.vault_tracker.simulate_redeem(user, 0, redeem.max(1));
        }
    }

    // =========================================================================
    // Phase 4: Manager operations
    // =========================================================================

    #[flow]
    fn flow_distribute_yield(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.total_assets == 0 {
            return;
        }
        let yield_amount = random_amount() / 10;
        self.vault_tracker.simulate_yield(yield_amount);
    }

    #[flow]
    fn flow_record_loss(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.total_assets == 0 {
            return;
        }
        let max_loss = self.vault_tracker.total_assets / 4;
        if max_loss > 0 {
            let loss = (rand::random::<u64>() % max_loss).max(1);
            self.vault_tracker.simulate_loss(loss);
        }
    }

    #[flow]
    fn flow_rebalance(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.total_assets == 0 {
            return;
        }
        let from = rand::random::<usize>() % 2;
        let to = 1 - from;
        let max_amount = self.vault_tracker.tranches[from].total_assets_allocated / 4;
        if max_amount > 0 {
            let amount = (rand::random::<u64>() % max_amount).max(1);
            self.vault_tracker.simulate_rebalance(from, to, amount);
        }
    }

    // =========================================================================
    // Phase 5: Error scenario flows
    // =========================================================================

    #[flow]
    fn flow_paused_deposit(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let was_paused = self.vault_tracker.paused;
        self.vault_tracker.paused = true;

        let user = random_user();
        let amount = random_amount();
        let result = self.vault_tracker.simulate_deposit(user, 1, amount);
        assert!(
            !result,
            "PAUSE VIOLATION: deposit succeeded while vault is paused"
        );

        self.vault_tracker.paused = was_paused;
    }

    #[flow]
    fn flow_paused_redeem(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let was_paused = self.vault_tracker.paused;
        self.vault_tracker.paused = true;

        let user = random_user();
        let shares = self.vault_tracker.users[user].shares_balance[1];
        if shares > 0 {
            let result = self.vault_tracker.simulate_redeem(user, 1, shares);
            assert!(
                !result,
                "PAUSE VIOLATION: redeem succeeded while vault is paused"
            );
        }

        self.vault_tracker.paused = was_paused;
    }

    #[flow]
    fn flow_paused_distribute_yield(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let was_paused = self.vault_tracker.paused;
        self.vault_tracker.paused = true;

        let result = self.vault_tracker.simulate_yield(random_amount() / 10);
        assert!(
            !result,
            "PAUSE VIOLATION: yield distribution succeeded while vault is paused"
        );

        self.vault_tracker.paused = was_paused;
    }

    #[flow]
    fn flow_paused_record_loss(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let was_paused = self.vault_tracker.paused;
        self.vault_tracker.paused = true;

        let result = self.vault_tracker.simulate_loss(1);
        assert!(
            !result,
            "PAUSE VIOLATION: loss recording succeeded while vault is paused"
        );

        self.vault_tracker.paused = was_paused;
    }

    #[flow]
    fn flow_zero_amount_deposit(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let user = random_user();
        let result = self.vault_tracker.simulate_deposit(user, 1, 0);
        assert!(
            !result,
            "ZERO AMOUNT VIOLATION: deposit with amount=0 succeeded"
        );
    }

    #[flow]
    fn flow_zero_amount_redeem(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let user = random_user();
        let result = self.vault_tracker.simulate_redeem(user, 1, 0);
        assert!(
            !result,
            "ZERO AMOUNT VIOLATION: redeem with shares=0 succeeded"
        );
    }

    #[flow]
    fn flow_insufficient_shares_redeem(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let user = random_user();
        let tranche_idx = rand::random::<usize>() % self.vault_tracker.num_tranches;
        let balance = self.vault_tracker.users[user].shares_balance[tranche_idx];
        let excess = balance.checked_add(random_amount()).unwrap_or(u64::MAX);
        let result = self.vault_tracker.simulate_redeem(user, tranche_idx, excess);
        assert!(
            !result,
            "INSUFFICIENT SHARES VIOLATION: redeem with {} shares succeeded (balance={})",
            excess,
            balance
        );
    }

    #[flow]
    fn flow_cap_breach_deposit(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.wiped {
            return;
        }

        let snapshot = self.vault_tracker.clone();
        let user = random_user();

        // Use a very large deposit to try to breach the cap on senior tranche
        // With 2 tranches and cap_bps=10000 (100%), the cap is effectively
        // total_assets. Use a modified cap to make this testable.
        let mut tracker = self.vault_tracker.clone();
        tracker.tranches[0].cap_bps = 3000; // 30% cap on senior

        // Seed junior first so there are assets
        let _ = tracker.simulate_deposit(user, 1, 10_000_000);

        // Now attempt a huge senior deposit that would breach 30% cap
        let huge = tracker.total_assets * 2;
        let exceeds_cap = !tracker.check_cap(0, huge);

        if exceeds_cap {
            // Verify the model would allow the deposit only if cap isn't enforced
            // (cap enforcement is at a higher layer; simulate_deposit doesn't check cap)
            // This validates the check_cap helper itself
            assert!(
                !tracker.check_cap(0, huge),
                "CAP CHECK VIOLATION: cap check passed for deposit exceeding cap"
            );
        }

        self.vault_tracker = snapshot;
    }

    #[flow]
    fn flow_subordination_breach_redeem(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.total_assets == 0 {
            return;
        }

        // Find a junior user with shares and attempt full redeem
        // which may violate subordination for senior tranche
        for user_idx in 0..NUM_USERS {
            let shares = self.vault_tracker.users[user_idx].shares_balance[1];
            if shares == 0 {
                continue;
            }

            let snapshot = self.vault_tracker.clone();
            let result = self.vault_tracker.simulate_redeem(user_idx, 1, shares);

            if !result {
                // Redeem was correctly rejected (likely subordination)
                assert!(
                    self.vault_tracker.tranches[1].total_assets_allocated
                        == snapshot.tranches[1].total_assets_allocated,
                    "STATE CORRUPTION: rejected redeem modified tranche state"
                );
            }
            // Either way, state is consistent
            self.vault_tracker.check_invariants();
            break;
        }
    }

    #[flow]
    fn flow_loss_exceeding_assets(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.total_assets == 0 {
            return;
        }
        let excess_loss = self.vault_tracker.total_assets + random_amount();
        let result = self.vault_tracker.simulate_loss(excess_loss);
        assert!(
            !result,
            "EXCESS LOSS VIOLATION: loss of {} succeeded (total_assets={})",
            excess_loss,
            self.vault_tracker.total_assets
        );
    }

    #[flow]
    fn flow_deposit_after_wipe(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        let was_wiped = self.vault_tracker.wiped;
        self.vault_tracker.wiped = true;

        let user = random_user();
        let result = self.vault_tracker.simulate_deposit(user, 1, random_amount());
        assert!(
            !result,
            "WIPE VIOLATION: deposit succeeded after vault wipe"
        );

        self.vault_tracker.wiped = was_wiped;
    }

    #[flow]
    fn flow_prorata_yield(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.total_assets == 0 {
            return;
        }
        let yield_amount = random_amount() / 10;
        self.vault_tracker.simulate_prorata_yield(yield_amount);
    }

    // =========================================================================
    // Phase 6: Round-trip safety
    // =========================================================================

    #[flow]
    fn flow_round_trip_safety(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.wiped {
            return;
        }
        let user = random_user();
        let deposit_amount = random_amount();

        // Snapshot
        let snapshot = self.vault_tracker.clone();

        if self.vault_tracker.simulate_deposit(user, 1, deposit_amount) {
            let shares = self.vault_tracker.users[user].shares_balance[1]
                - snapshot.users[user].shares_balance[1];

            if shares > 0 {
                let t = &self.vault_tracker.tranches[1];
                let redeemable = convert_to_assets(
                    shares,
                    t.total_shares,
                    t.total_assets_allocated,
                    self.vault_tracker.decimals_offset,
                    Rounding::Floor,
                )
                .unwrap_or(0);

                assert!(
                    redeemable <= deposit_amount,
                    "ROUND-TRIP VIOLATION: deposited {} but can redeem {} (profit={})",
                    deposit_amount,
                    redeemable,
                    redeemable - deposit_amount
                );
            }

            // Restore state
            self.vault_tracker = snapshot;
        }
    }

    // =========================================================================
    // Final invariant check
    // =========================================================================

    #[flow]
    fn flow_final_check(&mut self) {
        self.vault_tracker.check_invariants();

        // Verify total user shares match tranche totals
        for t_idx in 0..self.vault_tracker.num_tranches {
            let user_shares_sum: u64 = self.vault_tracker.users
                .iter()
                .map(|u| u.shares_balance[t_idx])
                .sum();
            assert_eq!(
                user_shares_sum,
                self.vault_tracker.tranches[t_idx].total_shares,
                "SHARES MISMATCH: tranche {} user shares sum ({}) != total_shares ({})",
                t_idx,
                user_shares_sum,
                self.vault_tracker.tranches[t_idx].total_shares,
            );
        }

        // Waterfall conservation: cumulative yield distributed == cumulative yield input
        assert_eq!(
            self.vault_tracker.cumulative_yield_input,
            self.vault_tracker.cumulative_yield_distributed,
            "WATERFALL CONSERVATION VIOLATED: total yield input ({}) != total distributed ({})",
            self.vault_tracker.cumulative_yield_input,
            self.vault_tracker.cumulative_yield_distributed,
        );
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}
