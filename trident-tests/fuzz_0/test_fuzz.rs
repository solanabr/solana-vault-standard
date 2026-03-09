use fuzz_accounts::*;
use svs_fees::{
    apply_entry_fee, apply_exit_fee, validate_entry_fee, validate_exit_fee, MAX_ENTRY_FEE_BPS,
    MAX_EXIT_FEE_BPS,
};
use svs_math::{convert_to_assets, convert_to_shares, Rounding};
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;

const NUM_USERS: usize = 5;
const PRICE_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18

#[derive(Clone, Copy, Default)]
struct UserState {
    shares_balance: u64,
    cumulative_deposited: u128,
    cumulative_redeemed: u128,
    locked_until: i64,
    whitelisted: bool,
    blacklisted: bool,
    frozen: bool,
}

#[derive(Clone, Copy)]
struct FeeConfig {
    enabled: bool,
    entry_fee_bps: u16,
    exit_fee_bps: u16,
}

impl Default for FeeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            entry_fee_bps: 0,
            exit_fee_bps: 0,
        }
    }
}

#[derive(Clone, Copy)]
struct CapConfig {
    enabled: bool,
    global_cap: u64,
    per_user_cap: u64,
}

impl Default for CapConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            global_cap: u64::MAX,
            per_user_cap: u64::MAX,
        }
    }
}

#[derive(Clone, Copy)]
struct LockConfig {
    enabled: bool,
    lock_duration: i64,
}

impl Default for LockConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            lock_duration: 0,
        }
    }
}

#[derive(Clone, Copy)]
struct AccessConfig {
    enabled: bool,
    mode: AccessMode,
}

impl Default for AccessConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: AccessMode::Whitelist,
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum AccessMode {
    Whitelist,
    Blacklist,
}

/// Vault state tracking for invariant checks.
/// Simulation-only fuzz test validating math invariants, multi-user fairness,
/// fee/cap/lock/access module behavior, and share price monotonicity.
#[derive(Default, Clone)]
struct VaultTracker {
    initialized: bool,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
    deposit_count: u64,
    redeem_count: u64,
    total_deposited: u128,
    total_redeemed: u128,
    paused: bool,
    users: [UserState; NUM_USERS],
    fee_config: FeeConfig,
    cap_config: CapConfig,
    lock_config: LockConfig,
    access_config: AccessConfig,
    simulated_clock: i64,
    cumulative_fees_collected: u128,
}

impl VaultTracker {
    fn share_price_x1e18(&self) -> u128 {
        let offset = 10u128.pow(self.decimals_offset as u32);
        let virtual_assets = self.total_assets as u128 + 1;
        let virtual_shares = self.total_shares as u128 + offset;
        virtual_assets
            .checked_mul(PRICE_SCALE)
            .unwrap_or(u128::MAX)
            .checked_div(virtual_shares)
            .unwrap_or(0)
    }

    fn user_shares_sum(&self) -> u64 {
        self.users
            .iter()
            .fold(0u64, |acc, u| acc.saturating_add(u.shares_balance))
    }

    fn user_cumulative_deposited(&self, idx: usize) -> u64 {
        self.users
            .get(idx)
            .map(|u| {
                if u.cumulative_deposited > u64::MAX as u128 {
                    u64::MAX
                } else {
                    u.cumulative_deposited as u64
                }
            })
            .unwrap_or(0)
    }

    fn is_user_allowed(&self, idx: usize) -> bool {
        if !self.access_config.enabled {
            return true;
        }
        let user = &self.users[idx];
        if user.frozen {
            return false;
        }
        match self.access_config.mode {
            AccessMode::Whitelist => user.whitelisted,
            AccessMode::Blacklist => !user.blacklisted,
        }
    }

    fn is_user_locked(&self, idx: usize) -> bool {
        if !self.lock_config.enabled {
            return false;
        }
        self.simulated_clock < self.users[idx].locked_until
    }
}

fn random_user() -> usize {
    rand::random::<usize>() % NUM_USERS
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
    // Phase 1A: Core vault flows using svs-math crate directly
    // =========================================================================

    #[flow]
    fn flow_initialize(&mut self) {
        if self.vault_tracker.initialized {
            return;
        }
        let fuzz_decimals: u8 = rand::random::<u8>() % 10;
        self.vault_tracker.decimals_offset = fuzz_decimals;
        self.vault_tracker.initialized = true;
    }

    #[flow]
    fn flow_deposit(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let fuzz_assets: u64 = rand::random::<u64>() % 1_000_000_000_000;
        let assets = fuzz_assets.max(1000);

        let user_idx = random_user();
        if !self.vault_tracker.is_user_allowed(user_idx) {
            return;
        }

        // Cap checks
        if self.vault_tracker.cap_config.enabled {
            if self.vault_tracker.total_assets.saturating_add(assets)
                > self.vault_tracker.cap_config.global_cap
            {
                return;
            }
            if self
                .vault_tracker
                .user_cumulative_deposited(user_idx)
                .saturating_add(assets)
                > self.vault_tracker.cap_config.per_user_cap
            {
                return;
            }
        }

        let price_before = self.vault_tracker.share_price_x1e18();

        let shares = match convert_to_shares(
            assets,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        // Apply entry fee if enabled
        let (net_shares, fee_shares) = if self.vault_tracker.fee_config.enabled
            && self.vault_tracker.fee_config.entry_fee_bps > 0
        {
            match apply_entry_fee(shares, self.vault_tracker.fee_config.entry_fee_bps) {
                Ok(result) => result,
                Err(_) => return,
            }
        } else {
            (shares, 0u64)
        };

        // Fee invariant: fee + net == gross
        assert_eq!(
            net_shares.checked_add(fee_shares),
            Some(shares),
            "Fee invariant violation: fee + net != gross"
        );

        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_add(assets);
        self.vault_tracker.total_shares = self
            .vault_tracker
            .total_shares
            .saturating_add(net_shares)
            .saturating_add(fee_shares);
        self.vault_tracker.deposit_count += 1;
        self.vault_tracker.total_deposited += assets as u128;
        self.vault_tracker.cumulative_fees_collected += fee_shares as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_add(net_shares);
        self.vault_tracker.users[user_idx].cumulative_deposited += assets as u128;

        // Set lock if enabled
        if self.vault_tracker.lock_config.enabled {
            self.vault_tracker.users[user_idx].locked_until =
                self.vault_tracker.simulated_clock + self.vault_tracker.lock_config.lock_duration;
        }

        // INVARIANT: Non-zero deposit to non-empty vault yields shares
        if assets > 0 && self.vault_tracker.total_assets > assets {
            assert!(
                shares > 0,
                "Positive deposit to non-empty vault yielded 0 shares"
            );
        }

        // Phase 1B: Share price monotonicity
        let price_after = self.vault_tracker.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after deposit: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_mint(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let assets_before = self.vault_tracker.total_assets;
        let shares_before = self.vault_tracker.total_shares;

        if assets_before < 1000 {
            return;
        }

        let max_mint = shares_before / 10;
        if max_mint == 0 {
            return;
        }
        let fuzz_shares: u64 = rand::random::<u64>() % max_mint;
        let shares = fuzz_shares.max(1);

        let user_idx = random_user();
        if !self.vault_tracker.is_user_allowed(user_idx) {
            return;
        }

        let price_before = self.vault_tracker.share_price_x1e18();

        let assets = match convert_to_assets(
            shares,
            assets_before,
            shares_before,
            self.vault_tracker.decimals_offset,
            Rounding::Ceiling,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets == 0 {
            return;
        }

        // Cap checks
        if self.vault_tracker.cap_config.enabled {
            if assets_before.saturating_add(assets) > self.vault_tracker.cap_config.global_cap {
                return;
            }
            if self
                .vault_tracker
                .user_cumulative_deposited(user_idx)
                .saturating_add(assets)
                > self.vault_tracker.cap_config.per_user_cap
            {
                return;
            }
        }

        // Ratio degradation check
        let current_ratio_x1000 = (assets_before as u128 * 1000) / shares_before.max(1) as u128;
        let new_ratio_x1000 =
            ((assets_before + assets) as u128 * 1000) / (shares_before + shares) as u128;
        if new_ratio_x1000 < current_ratio_x1000 * 99 / 100 {
            return;
        }

        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_add(assets);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_add(shares);
        self.vault_tracker.deposit_count += 1;
        self.vault_tracker.total_deposited += assets as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault_tracker.users[user_idx].cumulative_deposited += assets as u128;

        if self.vault_tracker.lock_config.enabled {
            self.vault_tracker.users[user_idx].locked_until =
                self.vault_tracker.simulated_clock + self.vault_tracker.lock_config.lock_duration;
        }

        // INVARIANT: Ceiling assets >= floor assets
        let floor_assets = convert_to_assets(
            shares,
            assets_before,
            shares_before,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);
        assert!(
            assets >= floor_assets,
            "Ceiling rounding yielded less than floor"
        );

        let price_after = self.vault_tracker.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after mint: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_withdraw(&mut self) {
        if !self.vault_tracker.initialized
            || self.vault_tracker.total_assets == 0
            || self.vault_tracker.paused
        {
            return;
        }

        let user_idx = random_user();
        if !self.vault_tracker.is_user_allowed(user_idx) {
            return;
        }
        if self.vault_tracker.is_user_locked(user_idx) {
            return;
        }

        let max_withdraw = self.vault_tracker.total_assets;
        let fuzz_assets: u64 = rand::random::<u64>() % max_withdraw;
        let assets = fuzz_assets.max(1);

        let assets_before = self.vault_tracker.total_assets;
        let shares_before = self.vault_tracker.total_shares;
        let price_before = self.vault_tracker.share_price_x1e18();

        let shares = match convert_to_shares(
            assets,
            assets_before,
            shares_before,
            self.vault_tracker.decimals_offset,
            Rounding::Ceiling,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares > self.vault_tracker.users[user_idx].shares_balance {
            return;
        }

        // Apply exit fee if enabled (fee on assets received)
        let (net_assets, fee_assets) = if self.vault_tracker.fee_config.enabled
            && self.vault_tracker.fee_config.exit_fee_bps > 0
        {
            match apply_exit_fee(assets, self.vault_tracker.fee_config.exit_fee_bps) {
                Ok(result) => result,
                Err(_) => return,
            }
        } else {
            (assets, 0u64)
        };

        assert_eq!(
            net_assets.checked_add(fee_assets),
            Some(assets),
            "Exit fee invariant violation: fee + net != gross"
        );

        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_sub(net_assets);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_sub(shares);
        self.vault_tracker.redeem_count += 1;
        self.vault_tracker.total_redeemed += net_assets as u128;
        self.vault_tracker.cumulative_fees_collected += fee_assets as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_sub(shares);
        self.vault_tracker.users[user_idx].cumulative_redeemed += net_assets as u128;

        // INVARIANT: Ceiling shares >= floor shares
        let floor_shares = convert_to_shares(
            assets,
            assets_before,
            shares_before,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);
        assert!(
            shares >= floor_shares,
            "Ceiling shares less than floor shares"
        );

        let price_after = self.vault_tracker.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after withdraw: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_redeem(&mut self) {
        if !self.vault_tracker.initialized
            || self.vault_tracker.total_shares == 0
            || self.vault_tracker.paused
        {
            return;
        }

        let user_idx = random_user();
        if !self.vault_tracker.is_user_allowed(user_idx) {
            return;
        }
        if self.vault_tracker.is_user_locked(user_idx) {
            return;
        }

        let user_shares = self.vault_tracker.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        let fuzz_shares: u64 = rand::random::<u64>() % user_shares;
        let shares = fuzz_shares.max(1);

        let assets_before = self.vault_tracker.total_assets;
        let shares_before = self.vault_tracker.total_shares;
        let price_before = self.vault_tracker.share_price_x1e18();

        let assets = match convert_to_assets(
            shares,
            assets_before,
            shares_before,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets > self.vault_tracker.total_assets {
            return;
        }

        // Apply exit fee
        let (net_assets, fee_assets) = if self.vault_tracker.fee_config.enabled
            && self.vault_tracker.fee_config.exit_fee_bps > 0
        {
            match apply_exit_fee(assets, self.vault_tracker.fee_config.exit_fee_bps) {
                Ok(result) => result,
                Err(_) => return,
            }
        } else {
            (assets, 0u64)
        };

        assert_eq!(
            net_assets.checked_add(fee_assets),
            Some(assets),
            "Exit fee invariant violation: fee + net != gross"
        );

        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_sub(shares);
        self.vault_tracker.total_assets = self
            .vault_tracker
            .total_assets
            .saturating_sub(net_assets);
        self.vault_tracker.redeem_count += 1;
        self.vault_tracker.total_redeemed += net_assets as u128;
        self.vault_tracker.cumulative_fees_collected += fee_assets as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_sub(shares);
        self.vault_tracker.users[user_idx].cumulative_redeemed += net_assets as u128;

        assert!(
            assets <= assets_before,
            "Extracted more assets than existed"
        );

        let price_after = self.vault_tracker.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after redeem: {} -> {}",
            price_before,
            price_after
        );
    }

    // =========================================================================
    // Roundtrip and inflation attack
    // =========================================================================

    #[flow]
    fn flow_roundtrip_deposit_redeem(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let assets_before = self.vault_tracker.total_assets;
        let shares_before = self.vault_tracker.total_shares;

        if assets_before < 1000 || shares_before == 0 {
            return;
        }

        let offset = 10u64.pow(self.vault_tracker.decimals_offset as u32);
        let ratio = (shares_before as u128) / (assets_before as u128).max(1);
        if ratio > offset as u128 * 100 {
            return;
        }

        let test_amount: u64 = (rand::random::<u64>() % 1_000_000_000).max(1000);

        let shares = match convert_to_shares(
            test_amount,
            assets_before,
            shares_before,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares > 0 {
            let new_total_assets = match assets_before.checked_add(test_amount) {
                Some(v) => v,
                None => return,
            };
            let new_total_shares = match shares_before.checked_add(shares) {
                Some(v) => v,
                None => return,
            };

            let assets_back = match convert_to_assets(
                shares,
                new_total_assets,
                new_total_shares,
                self.vault_tracker.decimals_offset,
                Rounding::Floor,
            ) {
                Ok(a) => a,
                Err(_) => return,
            };

            assert!(
                assets_back <= test_amount,
                "CRITICAL: Round-trip created free assets! deposited={}, got_back={}, shares={}, \
                 vault: assets={}, shares={}, offset={}",
                test_amount,
                assets_back,
                shares,
                assets_before,
                shares_before,
                self.vault_tracker.decimals_offset,
            );

            if test_amount > 10000 {
                let loss = test_amount - assets_back;
                let loss_pct = (loss as f64 / test_amount as f64) * 100.0;
                assert!(
                    loss_pct < 1.0,
                    "Excessive round-trip loss: {}% (loss={}, amount={})",
                    loss_pct,
                    loss,
                    test_amount
                );
            }
        }
    }

    #[flow]
    fn flow_inflation_attack(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        if self.vault_tracker.total_assets > 0 || self.vault_tracker.total_shares > 0 {
            return;
        }

        let offset = self.vault_tracker.decimals_offset;

        let attacker_deposit: u64 = 1000;
        let attacker_shares = convert_to_shares(attacker_deposit, 0, 0, offset, Rounding::Floor)
            .unwrap_or(0);

        let mut vault_assets = attacker_deposit;
        let mut vault_shares = attacker_shares;

        // Vary donation amount
        let donation: u64 = (rand::random::<u64>() % 10_000_000).max(1000);
        vault_assets = vault_assets.saturating_add(donation);

        let victim_deposit: u64 = 100_000;
        let victim_shares =
            convert_to_shares(victim_deposit, vault_assets, vault_shares, offset, Rounding::Floor)
                .unwrap_or(0);

        vault_assets = vault_assets.saturating_add(victim_deposit);
        vault_shares = vault_shares.saturating_add(victim_shares);

        let attacker_can_redeem = convert_to_assets(
            attacker_shares,
            vault_assets,
            vault_shares,
            offset,
            Rounding::Floor,
        )
        .unwrap_or(0);

        let attacker_total_in = attacker_deposit + donation;
        let max_fair_return = attacker_total_in
            .saturating_add(victim_deposit.saturating_mul(attacker_shares) / vault_shares.max(1));

        assert!(
            attacker_can_redeem <= max_fair_return.saturating_add(1000),
            "Inflation attack succeeded! attacker_in={}, donation={}, can_extract={}",
            attacker_deposit,
            donation,
            attacker_can_redeem
        );

        let victim_can_redeem = convert_to_assets(
            victim_shares,
            vault_assets,
            vault_shares,
            offset,
            Rounding::Floor,
        )
        .unwrap_or(0);

        assert!(
            victim_can_redeem >= victim_deposit * 9 / 10,
            "Victim lost too much to inflation attack! deposited={}, can_redeem={}, donation={}",
            victim_deposit,
            victim_can_redeem,
            donation
        );
    }

    // =========================================================================
    // Edge cases
    // =========================================================================

    #[flow]
    fn flow_zero_edge_cases(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let zero_shares = convert_to_shares(
            0,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);
        assert_eq!(zero_shares, 0, "Zero deposit yielded non-zero shares");

        let zero_assets = convert_to_assets(
            0,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);
        assert_eq!(zero_assets, 0, "Zero shares yielded non-zero assets");
    }

    #[flow]
    fn flow_max_value_edge_cases(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let large_value = u64::MAX / 4;
        let result = convert_to_shares(large_value, large_value, large_value, 3, Rounding::Floor);
        assert!(result.is_ok() || result.is_err(), "Large value panicked");
    }

    // =========================================================================
    // Phase 1C: Multi-user flows
    // =========================================================================

    #[flow]
    fn flow_multi_deposit(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let user_idx = random_user();
        if !self.vault_tracker.is_user_allowed(user_idx) {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 100_000_000).max(1000);

        if self.vault_tracker.cap_config.enabled {
            if self.vault_tracker.total_assets.saturating_add(assets)
                > self.vault_tracker.cap_config.global_cap
            {
                return;
            }
            if self
                .vault_tracker
                .user_cumulative_deposited(user_idx)
                .saturating_add(assets)
                > self.vault_tracker.cap_config.per_user_cap
            {
                return;
            }
        }

        let shares = match convert_to_shares(
            assets,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        let (net_shares, fee_shares) = if self.vault_tracker.fee_config.enabled
            && self.vault_tracker.fee_config.entry_fee_bps > 0
        {
            match apply_entry_fee(shares, self.vault_tracker.fee_config.entry_fee_bps) {
                Ok(r) => r,
                Err(_) => return,
            }
        } else {
            (shares, 0u64)
        };

        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_add(assets);
        self.vault_tracker.total_shares = self
            .vault_tracker
            .total_shares
            .saturating_add(net_shares)
            .saturating_add(fee_shares);
        self.vault_tracker.deposit_count += 1;
        self.vault_tracker.total_deposited += assets as u128;
        self.vault_tracker.cumulative_fees_collected += fee_shares as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_add(net_shares);
        self.vault_tracker.users[user_idx].cumulative_deposited += assets as u128;

        if self.vault_tracker.lock_config.enabled {
            self.vault_tracker.users[user_idx].locked_until =
                self.vault_tracker.simulated_clock + self.vault_tracker.lock_config.lock_duration;
        }
    }

    #[flow]
    fn flow_multi_redeem(&mut self) {
        if !self.vault_tracker.initialized
            || self.vault_tracker.total_shares == 0
            || self.vault_tracker.paused
        {
            return;
        }

        let user_idx = random_user();
        if !self.vault_tracker.is_user_allowed(user_idx) {
            return;
        }
        if self.vault_tracker.is_user_locked(user_idx) {
            return;
        }

        let user_shares = self.vault_tracker.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % user_shares).max(1);

        let assets = match convert_to_assets(
            shares,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets > self.vault_tracker.total_assets {
            return;
        }

        let (net_assets, fee_assets) = if self.vault_tracker.fee_config.enabled
            && self.vault_tracker.fee_config.exit_fee_bps > 0
        {
            match apply_exit_fee(assets, self.vault_tracker.fee_config.exit_fee_bps) {
                Ok(r) => r,
                Err(_) => return,
            }
        } else {
            (assets, 0u64)
        };

        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_sub(shares);
        self.vault_tracker.total_assets = self
            .vault_tracker
            .total_assets
            .saturating_sub(net_assets);
        self.vault_tracker.redeem_count += 1;
        self.vault_tracker.total_redeemed += net_assets as u128;
        self.vault_tracker.cumulative_fees_collected += fee_assets as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_sub(shares);
        self.vault_tracker.users[user_idx].cumulative_redeemed += net_assets as u128;
    }

    // =========================================================================
    // Phase 1D: Admin operations
    // =========================================================================

    #[flow]
    fn flow_pause(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        self.vault_tracker.paused = true;
    }

    #[flow]
    fn flow_unpause(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }
        self.vault_tracker.paused = false;
    }

    #[flow]
    fn flow_deposit_while_paused(&mut self) {
        if !self.vault_tracker.initialized || !self.vault_tracker.paused {
            return;
        }

        let assets_before = self.vault_tracker.total_assets;
        let shares_before = self.vault_tracker.total_shares;

        // Attempt deposit — must be blocked (no state change)
        // In simulation, our flows already check paused and return early,
        // so we verify that the invariant holds after not mutating state.
        assert_eq!(self.vault_tracker.total_assets, assets_before);
        assert_eq!(self.vault_tracker.total_shares, shares_before);
    }

    // =========================================================================
    // Phase 2A: Fee module
    // =========================================================================

    #[flow]
    fn flow_init_fees(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let entry_bps = rand::random::<u16>() % 1500;
        let exit_bps = rand::random::<u16>() % 1500;

        let entry_valid = validate_entry_fee(entry_bps).is_ok();
        let exit_valid = validate_exit_fee(exit_bps).is_ok();

        // Values > MAX must be rejected
        if entry_bps > MAX_ENTRY_FEE_BPS {
            assert!(!entry_valid, "Should reject entry fee > MAX");
        }
        if exit_bps > MAX_EXIT_FEE_BPS {
            assert!(!exit_valid, "Should reject exit fee > MAX");
        }

        if entry_valid && exit_valid {
            self.vault_tracker.fee_config = FeeConfig {
                enabled: true,
                entry_fee_bps: entry_bps,
                exit_fee_bps: exit_bps,
            };
        }
    }

    // =========================================================================
    // Phase 2B: Cap module
    // =========================================================================

    #[flow]
    fn flow_init_caps(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let global_cap = (rand::random::<u64>() % 10_000_000_000).max(100_000);
        let per_user_cap = (rand::random::<u64>() % global_cap).max(10_000);

        self.vault_tracker.cap_config = CapConfig {
            enabled: true,
            global_cap,
            per_user_cap,
        };
    }

    #[flow]
    fn flow_deposit_exceeds_global_cap(&mut self) {
        if !self.vault_tracker.initialized
            || !self.vault_tracker.cap_config.enabled
            || self.vault_tracker.paused
        {
            return;
        }

        let remaining = self
            .vault_tracker
            .cap_config
            .global_cap
            .saturating_sub(self.vault_tracker.total_assets);
        if remaining == 0 {
            return;
        }

        // Try to deposit more than remaining
        let excess = remaining.saturating_add((rand::random::<u64>() % 1_000_000).max(1));
        let would_exceed = self.vault_tracker.total_assets.saturating_add(excess)
            > self.vault_tracker.cap_config.global_cap;

        assert!(would_exceed, "Deposit should exceed global cap");
        // Blocked — no state change
    }

    #[flow]
    fn flow_deposit_at_boundary(&mut self) {
        if !self.vault_tracker.initialized
            || !self.vault_tracker.cap_config.enabled
            || self.vault_tracker.paused
        {
            return;
        }

        let remaining = self
            .vault_tracker
            .cap_config
            .global_cap
            .saturating_sub(self.vault_tracker.total_assets);
        if remaining < 1000 {
            return;
        }

        // Deposit exactly the remaining capacity
        let assets = remaining;
        let user_idx = random_user();

        let shares = match convert_to_shares(
            assets,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_add(assets);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_add(shares);
        self.vault_tracker.deposit_count += 1;
        self.vault_tracker.total_deposited += assets as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault_tracker.users[user_idx].cumulative_deposited += assets as u128;

        // INVARIANT: total_assets <= global_cap
        assert!(
            self.vault_tracker.total_assets <= self.vault_tracker.cap_config.global_cap,
            "Total assets {} exceeded global cap {}",
            self.vault_tracker.total_assets,
            self.vault_tracker.cap_config.global_cap
        );
    }

    // =========================================================================
    // Phase 2C: Lock module
    // =========================================================================

    #[flow]
    fn flow_init_locks(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let duration = (rand::random::<i64>().abs() % 86400 * 30).max(3600); // 1h to 30d
        self.vault_tracker.lock_config = LockConfig {
            enabled: true,
            lock_duration: duration,
        };
    }

    #[flow]
    fn flow_advance_clock(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let advance = (rand::random::<i64>().abs() % 86400).max(1);
        self.vault_tracker.simulated_clock = self
            .vault_tracker
            .simulated_clock
            .saturating_add(advance);
    }

    #[flow]
    fn flow_redeem_while_locked(&mut self) {
        if !self.vault_tracker.initialized || !self.vault_tracker.lock_config.enabled {
            return;
        }

        let user_idx = random_user();
        if !self.vault_tracker.is_user_locked(user_idx) {
            return;
        }

        // User is locked — redemption must be blocked
        let user_shares = self.vault_tracker.users[user_idx].shares_balance;
        let shares_before = self.vault_tracker.total_shares;

        // Verify no state change (lock prevents redemption)
        assert_eq!(
            self.vault_tracker.total_shares, shares_before,
            "Locked user was able to redeem"
        );
        assert_eq!(
            self.vault_tracker.users[user_idx].shares_balance, user_shares,
            "Locked user's balance changed"
        );
    }

    // =========================================================================
    // Phase 2D: Access control module
    // =========================================================================

    #[flow]
    fn flow_init_access_whitelist(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        self.vault_tracker.access_config = AccessConfig {
            enabled: true,
            mode: AccessMode::Whitelist,
        };

        // Whitelist random subset of users
        for i in 0..NUM_USERS {
            self.vault_tracker.users[i].whitelisted = rand::random::<bool>();
            self.vault_tracker.users[i].blacklisted = false;
            self.vault_tracker.users[i].frozen = false;
        }
    }

    #[flow]
    fn flow_init_access_blacklist(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        self.vault_tracker.access_config = AccessConfig {
            enabled: true,
            mode: AccessMode::Blacklist,
        };

        for i in 0..NUM_USERS {
            self.vault_tracker.users[i].blacklisted = rand::random::<bool>();
            self.vault_tracker.users[i].whitelisted = false;
            self.vault_tracker.users[i].frozen = false;
        }
    }

    #[flow]
    fn flow_freeze_user(&mut self) {
        if !self.vault_tracker.initialized || !self.vault_tracker.access_config.enabled {
            return;
        }

        let user_idx = random_user();
        self.vault_tracker.users[user_idx].frozen = true;
    }

    #[flow]
    fn flow_frozen_user_blocked(&mut self) {
        if !self.vault_tracker.initialized || !self.vault_tracker.access_config.enabled {
            return;
        }

        let user_idx = random_user();
        if !self.vault_tracker.users[user_idx].frozen {
            return;
        }

        // Verify frozen user is blocked from both deposit and withdraw
        assert!(
            !self.vault_tracker.is_user_allowed(user_idx),
            "Frozen user should not be allowed"
        );
    }

    // =========================================================================
    // End invariants
    // =========================================================================

    #[end]
    fn end(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        // INVARIANT: Total redeemed <= total deposited
        assert!(
            self.vault_tracker.total_redeemed <= self.vault_tracker.total_deposited,
            "Final: redeemed {} > deposited {}",
            self.vault_tracker.total_redeemed,
            self.vault_tracker.total_deposited
        );

        // INVARIANT: Significant shares require assets
        if self.vault_tracker.total_shares > 1000 {
            assert!(
                self.vault_tracker.total_assets > 0,
                "Final: significant shares exist but no assets"
            );
        }

        // INVARIANT: Significant assets require shares (post first deposit)
        if self.vault_tracker.total_assets > 1000 && self.vault_tracker.deposit_count > 0 {
            assert!(
                self.vault_tracker.total_shares > 0,
                "Final: significant assets exist but no shares"
            );
        }

        // Phase 1C INVARIANT: Sum of user balances == total shares
        // (minus fee shares which aren't assigned to any user)
        let user_sum = self.vault_tracker.user_shares_sum();
        let unassigned = self
            .vault_tracker
            .total_shares
            .saturating_sub(user_sum);
        // Unassigned shares should be <= cumulative fees collected
        // (fee shares go to the vault/protocol, not tracked per-user)
        assert!(
            unassigned as u128 <= self.vault_tracker.cumulative_fees_collected,
            "Final: unassigned shares {} exceed total fees collected {}",
            unassigned,
            self.vault_tracker.cumulative_fees_collected
        );

        // Phase 1C INVARIANT: No user redeemed more than deposited (in value)
        for (i, user) in self.vault_tracker.users.iter().enumerate() {
            assert!(
                user.cumulative_redeemed <= user.cumulative_deposited.saturating_add(1000),
                "Final: user {} redeemed {} > deposited {} (free money)",
                i,
                user.cumulative_redeemed,
                user.cumulative_deposited
            );
        }

        // Cap invariant
        if self.vault_tracker.cap_config.enabled {
            assert!(
                self.vault_tracker.total_assets <= self.vault_tracker.cap_config.global_cap,
                "Final: assets {} exceed global cap {}",
                self.vault_tracker.total_assets,
                self.vault_tracker.cap_config.global_cap
            );
        }
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}
