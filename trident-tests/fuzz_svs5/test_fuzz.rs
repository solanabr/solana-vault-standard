use fuzz_accounts::*;
use svs_fees::{
    apply_entry_fee, apply_exit_fee, validate_entry_fee, validate_exit_fee, MAX_ENTRY_FEE_BPS,
    MAX_EXIT_FEE_BPS,
};
use svs_math::{convert_to_assets, convert_to_shares, mul_div, Rounding};
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;

const NUM_USERS: usize = 5;
const PRICE_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18

#[derive(Default, Clone, Copy)]
struct UserState {
    shares_balance: u64,
    cumulative_deposited: u128,
    cumulative_redeemed: u128,
    locked_until: i64,
    whitelisted: bool,
    blacklisted: bool,
    frozen: bool,
}

#[derive(Clone, Copy, Default)]
struct FeeConfig {
    enabled: bool,
    entry_fee_bps: u16,
    exit_fee_bps: u16,
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

#[derive(Clone, Copy, Default)]
struct LockConfig {
    enabled: bool,
    lock_duration: i64,
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

/// SVS-5 Streaming Vault state tracker.
/// Simulation-only fuzz test validating math invariants, streaming yield,
/// multi-user fairness, fee/cap/lock/access module behavior, and share price monotonicity.
#[derive(Clone)]
struct SVS5VaultTracker {
    initialized: bool,
    base_assets: u64,
    stream_amount: u64,
    stream_start: i64,
    stream_end: i64,
    last_checkpoint: i64,
    total_shares: u64,
    decimals_offset: u8,
    clock: i64,
    paused: bool,
    users: [UserState; NUM_USERS],
    deposit_count: u64,
    redeem_count: u64,
    total_deposited: u128,
    total_redeemed: u128,
    fee_config: FeeConfig,
    cap_config: CapConfig,
    lock_config: LockConfig,
    access_config: AccessConfig,
    cumulative_fees_collected: u128,
    total_withdrawn: u128,
    price_before_stream: u128,
}

impl Default for SVS5VaultTracker {
    fn default() -> Self {
        Self {
            initialized: false,
            base_assets: 0,
            stream_amount: 0,
            stream_start: 0,
            stream_end: 0,
            last_checkpoint: 0,
            total_shares: 0,
            decimals_offset: 0,
            clock: 1000,
            paused: false,
            users: [UserState::default(); NUM_USERS],
            deposit_count: 0,
            redeem_count: 0,
            total_deposited: 0,
            total_redeemed: 0,
            fee_config: FeeConfig::default(),
            cap_config: CapConfig::default(),
            lock_config: LockConfig::default(),
            access_config: AccessConfig::default(),
            cumulative_fees_collected: 0,
            total_withdrawn: 0,
            price_before_stream: 0,
        }
    }
}

impl SVS5VaultTracker {
    fn effective_total_assets(&self) -> u64 {
        if self.stream_amount == 0 || self.clock <= self.stream_start {
            return self.base_assets;
        }
        if self.clock >= self.stream_end {
            return self.base_assets.saturating_add(self.stream_amount);
        }
        let elapsed = (self.clock - self.stream_start) as u64;
        let duration = (self.stream_end - self.stream_start) as u64;
        let accrued =
            mul_div(self.stream_amount, elapsed, duration, Rounding::Floor).unwrap_or(0);
        self.base_assets.saturating_add(accrued)
    }

    fn share_price_x1e18(&self) -> u128 {
        let effective = self.effective_total_assets();
        let offset = 10u128.pow(self.decimals_offset as u32);
        let virtual_assets = effective as u128 + 1;
        let virtual_shares = self.total_shares as u128 + offset;
        virtual_assets
            .checked_mul(PRICE_SCALE)
            .unwrap_or(u128::MAX)
            .checked_div(virtual_shares)
            .unwrap_or(0)
    }

    fn total_user_shares(&self) -> u64 {
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

    fn has_active_stream(&self) -> bool {
        self.stream_amount > 0 && self.clock < self.stream_end
    }

    fn checkpoint(&mut self) {
        if self.stream_amount == 0 {
            return;
        }
        let effective = self.effective_total_assets();
        let accrued = effective.saturating_sub(self.base_assets);
        self.base_assets = effective;
        if self.clock >= self.stream_end {
            self.stream_amount = 0;
            self.stream_start = 0;
            self.stream_end = 0;
        } else {
            self.stream_amount = self.stream_amount.saturating_sub(accrued);
            self.stream_start = self.clock;
        }
        self.last_checkpoint = self.clock;
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
        self.clock < self.users[idx].locked_until
    }
}

fn random_user() -> usize {
    rand::random::<usize>() % NUM_USERS
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    vault: SVS5VaultTracker,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            vault: SVS5VaultTracker::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        self.vault = SVS5VaultTracker::default();
    }

    // =========================================================================
    // Phase 1A: Core vault flows
    // =========================================================================

    #[flow]
    fn flow_initialize(&mut self) {
        if self.vault.initialized {
            return;
        }
        let offset = (rand::random::<u8>() % 10) as u8;
        self.vault.decimals_offset = offset;
        self.vault.initialized = true;
    }

    #[flow]
    fn flow_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        if !self.vault.is_user_allowed(user_idx) {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 100_000_000).max(1000);

        // Cap checks
        if self.vault.cap_config.enabled {
            let effective = self.vault.effective_total_assets();
            if effective.saturating_add(assets) > self.vault.cap_config.global_cap {
                return;
            }
            if self
                .vault
                .user_cumulative_deposited(user_idx)
                .saturating_add(assets)
                > self.vault.cap_config.per_user_cap
            {
                return;
            }
        }

        let price_before = self.vault.share_price_x1e18();

        let effective = self.vault.effective_total_assets();
        let shares = match convert_to_shares(
            assets,
            effective,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        // Apply entry fee if enabled
        let (net_shares, fee_shares) = if self.vault.fee_config.enabled
            && self.vault.fee_config.entry_fee_bps > 0
        {
            match apply_entry_fee(shares, self.vault.fee_config.entry_fee_bps) {
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

        if net_shares == 0 {
            return;
        }

        self.vault.base_assets = self.vault.base_assets.saturating_add(assets);
        self.vault.total_shares = self
            .vault
            .total_shares
            .saturating_add(net_shares)
            .saturating_add(fee_shares);
        self.vault.deposit_count += 1;
        self.vault.total_deposited += assets as u128;
        self.vault.cumulative_fees_collected += fee_shares as u128;

        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(net_shares);
        self.vault.users[user_idx].cumulative_deposited += assets as u128;

        // Set lock if enabled
        if self.vault.lock_config.enabled {
            self.vault.users[user_idx].locked_until =
                self.vault.clock + self.vault.lock_config.lock_duration;
        }

        // INVARIANT: Share price monotonicity
        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after deposit: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_redeem(&mut self) {
        if !self.vault.initialized || self.vault.total_shares == 0 || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        if !self.vault.is_user_allowed(user_idx) {
            return;
        }
        if self.vault.is_user_locked(user_idx) {
            return;
        }

        let user_shares = self.vault.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % user_shares).max(1);

        // SVS-5: Auto-checkpoint before redeem
        self.vault.checkpoint();

        let price_before = self.vault.share_price_x1e18();
        let total_assets = self.vault.base_assets;

        let assets = match convert_to_assets(
            shares,
            total_assets,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets == 0 || assets > self.vault.base_assets {
            return;
        }

        // Apply exit fee
        let (net_assets, fee_assets) = if self.vault.fee_config.enabled
            && self.vault.fee_config.exit_fee_bps > 0
        {
            match apply_exit_fee(assets, self.vault.fee_config.exit_fee_bps) {
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

        self.vault.base_assets = self.vault.base_assets.saturating_sub(net_assets);
        self.vault.total_shares = self.vault.total_shares.saturating_sub(shares);
        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_sub(shares);
        self.vault.users[user_idx].cumulative_redeemed += net_assets as u128;
        self.vault.redeem_count += 1;
        self.vault.total_redeemed += net_assets as u128;
        self.vault.total_withdrawn += net_assets as u128;
        self.vault.cumulative_fees_collected += fee_assets as u128;

        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after redeem: {} -> {}",
            price_before,
            price_after
        );
    }

    // =========================================================================
    // SVS-5 Streaming yield flows
    // =========================================================================

    #[flow]
    fn flow_distribute_yield(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        if self.vault.has_active_stream() {
            self.vault.checkpoint();
        }

        // Record price before stream for post-stream invariant
        self.vault.price_before_stream = self.vault.share_price_x1e18();

        let amount: u64 = (rand::random::<u64>() % 10_000_000).max(1);
        let duration: i64 = (rand::random::<i64>().unsigned_abs() % 86341 + 60) as i64;

        self.vault.stream_amount = amount;
        self.vault.stream_start = self.vault.clock;
        self.vault.stream_end = self.vault.clock.saturating_add(duration);
        self.vault.last_checkpoint = self.vault.clock;
    }

    #[flow]
    fn flow_checkpoint(&mut self) {
        if !self.vault.initialized {
            return;
        }
        self.vault.checkpoint();
    }

    #[flow]
    fn flow_advance_clock(&mut self) {
        if !self.vault.initialized {
            return;
        }
        let advance: i64 = (rand::random::<i64>().unsigned_abs() % 3600 + 1) as i64;
        self.vault.clock = self.vault.clock.saturating_add(advance);
    }

    #[flow]
    fn flow_deposit_mid_stream(&mut self) {
        if !self.vault.initialized || !self.vault.has_active_stream() || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        if !self.vault.is_user_allowed(user_idx) {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 50_000_000).max(1000);

        let effective = self.vault.effective_total_assets();

        assert!(
            effective >= self.vault.base_assets,
            "Mid-stream effective {} < base {} during active stream",
            effective,
            self.vault.base_assets
        );

        let shares = match convert_to_shares(
            assets,
            effective,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares == 0 {
            return;
        }

        self.vault.base_assets = self.vault.base_assets.saturating_add(assets);
        self.vault.total_shares = self.vault.total_shares.saturating_add(shares);
        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault.users[user_idx].cumulative_deposited += assets as u128;
        self.vault.deposit_count += 1;
        self.vault.total_deposited += assets as u128;

        if self.vault.lock_config.enabled {
            self.vault.users[user_idx].locked_until =
                self.vault.clock + self.vault.lock_config.lock_duration;
        }
    }

    #[flow]
    fn flow_roundtrip_deposit_redeem(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let user_idx = random_user();
        let assets: u64 = (rand::random::<u64>() % 10_000_000).max(10_000);

        let effective_before = self.vault.effective_total_assets();
        let total_shares_before = self.vault.total_shares;

        let shares = match convert_to_shares(
            assets,
            effective_before,
            total_shares_before,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares == 0 {
            return;
        }

        self.vault.base_assets = self.vault.base_assets.saturating_add(assets);
        self.vault.total_shares = self.vault.total_shares.saturating_add(shares);

        let effective_after_deposit = self.vault.effective_total_assets();

        let assets_back = match convert_to_assets(
            shares,
            effective_after_deposit,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => {
                self.vault.base_assets = self.vault.base_assets.saturating_sub(assets);
                self.vault.total_shares = self.vault.total_shares.saturating_sub(shares);
                return;
            }
        };

        assert!(
            assets_back <= assets,
            "Round-trip profit: deposited {} assets, got {} back (shares={})",
            assets,
            assets_back,
            shares
        );

        self.vault.base_assets = self.vault.base_assets.saturating_sub(assets_back);
        self.vault.total_shares = self.vault.total_shares.saturating_sub(shares);

        self.vault.users[user_idx].cumulative_deposited += assets as u128;
        self.vault.users[user_idx].cumulative_redeemed += assets_back as u128;
        self.vault.deposit_count += 1;
        self.vault.redeem_count += 1;
        self.vault.total_deposited += assets as u128;
        self.vault.total_redeemed += assets_back as u128;
    }

    // =========================================================================
    // SVS-5 specific: Pause during active stream
    // =========================================================================

    #[flow]
    fn flow_pause(&mut self) {
        if !self.vault.initialized {
            return;
        }
        self.vault.paused = true;
    }

    #[flow]
    fn flow_unpause(&mut self) {
        if !self.vault.initialized {
            return;
        }
        self.vault.paused = false;
    }

    #[flow]
    fn flow_pause_during_active_stream(&mut self) {
        if !self.vault.initialized || !self.vault.has_active_stream() {
            return;
        }

        let effective_before = self.vault.effective_total_assets();
        self.vault.paused = true;

        // Stream should continue accruing even when paused
        let effective_after = self.vault.effective_total_assets();
        assert_eq!(
            effective_before, effective_after,
            "Effective total assets changed on pause (no clock advance)"
        );
    }

    #[flow]
    fn flow_multiple_distribute_yield(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }
        if !self.vault.has_active_stream() {
            return;
        }

        // Advance clock partway through current stream
        let mid = (self.vault.stream_end - self.vault.stream_start) / 3;
        self.vault.clock = self.vault.stream_start.saturating_add(mid.max(1));

        let base_before = self.vault.base_assets;

        // Auto-checkpoint
        self.vault.checkpoint();

        // Base assets should have increased from accrued yield
        assert!(
            self.vault.base_assets >= base_before,
            "Checkpoint decreased base_assets: {} -> {}",
            base_before,
            self.vault.base_assets
        );

        // Start new stream
        let amount: u64 = (rand::random::<u64>() % 5_000_000).max(1);
        let duration: i64 = (rand::random::<i64>().unsigned_abs() % 86341 + 60) as i64;

        self.vault.stream_amount = amount;
        self.vault.stream_start = self.vault.clock;
        self.vault.stream_end = self.vault.clock.saturating_add(duration);
    }

    // =========================================================================
    // Inflation attack during streaming
    // =========================================================================

    #[flow]
    fn flow_inflation_attack_during_stream(&mut self) {
        if !self.vault.initialized {
            return;
        }
        if self.vault.total_shares > 0 || self.vault.base_assets > 0 {
            return;
        }

        let offset = self.vault.decimals_offset;

        // Attacker deposits
        let attacker_deposit: u64 = 1000;
        let attacker_shares = convert_to_shares(attacker_deposit, 0, 0, offset, Rounding::Floor)
            .unwrap_or(0);

        let mut vault_assets = attacker_deposit;
        let mut vault_shares = attacker_shares;

        // Start a stream
        let _stream_amount: u64 = 50_000;

        // Donation attack
        let donation: u64 = (rand::random::<u64>() % 10_000_000).max(1000);
        vault_assets = vault_assets.saturating_add(donation);

        // Victim deposits (uses effective total which includes stream, but stream just started)
        let victim_deposit: u64 = 100_000;
        let victim_shares =
            convert_to_shares(victim_deposit, vault_assets, vault_shares, offset, Rounding::Floor)
                .unwrap_or(0);

        vault_assets = vault_assets.saturating_add(victim_deposit);
        vault_shares = vault_shares.saturating_add(victim_shares);

        // Check victim can recover most of deposit
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
            "Victim lost too much to inflation attack during stream! deposited={}, can_redeem={}, donation={}",
            victim_deposit,
            victim_can_redeem,
            donation
        );
    }

    // =========================================================================
    // Stream timing edge cases (reviewer-requested)
    // =========================================================================

    /// Jump days/weeks ahead — test stream completion and post-stream behavior
    #[flow]
    fn flow_extreme_clock_jump(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let price_before = self.vault.share_price_x1e18();
        let had_active_stream = self.vault.has_active_stream();

        // Jump 1-30 days ahead
        let days = (rand::random::<i64>().unsigned_abs() % 30 + 1) as i64;
        let advance = days * 86400;
        self.vault.clock = self.vault.clock.saturating_add(advance);

        let effective_after = self.vault.effective_total_assets();

        // If stream was active, it should now be fully elapsed
        if had_active_stream {
            let max_effective = self.vault.base_assets.saturating_add(self.vault.stream_amount);
            assert_eq!(
                effective_after, max_effective,
                "Extreme jump: stream should be fully elapsed, effective {} != base + stream {}",
                effective_after, max_effective
            );
        }

        // Share price should never decrease from time advancing alone
        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased from clock advance: {} -> {}",
            price_before,
            price_after
        );
    }

    /// Multiple distribute_yield calls in quick succession — stress auto-checkpoint
    #[flow]
    fn flow_stream_replacement_rapid(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let price_before = self.vault.share_price_x1e18();

        // Start 3 streams in rapid succession (1s apart)
        for _ in 0..3 {
            if self.vault.has_active_stream() {
                let base_before = self.vault.base_assets;
                self.vault.checkpoint();
                assert!(
                    self.vault.base_assets >= base_before,
                    "Rapid replacement: checkpoint decreased base_assets"
                );
            }

            let amount: u64 = (rand::random::<u64>() % 5_000_000).max(1);
            let duration: i64 = (rand::random::<i64>().unsigned_abs() % 86341 + 60) as i64;

            self.vault.stream_amount = amount;
            self.vault.stream_start = self.vault.clock;
            self.vault.stream_end = self.vault.clock.saturating_add(duration);
            self.vault.last_checkpoint = self.vault.clock;

            // Advance 1 second between replacements
            self.vault.clock = self.vault.clock.saturating_add(1);
        }

        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after rapid stream replacements: {} -> {}",
            price_before,
            price_after
        );
    }

    /// Checkpoint called long after stream completed — verify idempotency
    #[flow]
    fn flow_checkpoint_after_stream_end(&mut self) {
        if !self.vault.initialized {
            return;
        }
        // Only run when stream has ended but hasn't been checkpointed
        if self.vault.stream_amount == 0 {
            return;
        }
        if self.vault.clock < self.vault.stream_end {
            return;
        }

        // Jump even further past stream end
        let extra = (rand::random::<i64>().unsigned_abs() % 604800 + 3600) as i64; // 1h to 1 week
        self.vault.clock = self.vault.clock.saturating_add(extra);

        let expected_base = self.vault.base_assets.saturating_add(self.vault.stream_amount);

        self.vault.checkpoint();

        assert_eq!(
            self.vault.base_assets, expected_base,
            "Late checkpoint: base_assets {} != expected {} (original base + stream)",
            self.vault.base_assets, expected_base
        );
        assert_eq!(
            self.vault.stream_amount, 0,
            "Late checkpoint: stream_amount should be 0 after full stream, got {}",
            self.vault.stream_amount
        );

        // Second checkpoint should be a no-op
        let base_after_first = self.vault.base_assets;
        self.vault.checkpoint();
        assert_eq!(
            self.vault.base_assets, base_after_first,
            "Late checkpoint: second checkpoint changed base_assets {} -> {}",
            base_after_first, self.vault.base_assets
        );
    }

    /// Deposit when stream finished but no checkpoint yet —
    /// effective should include full stream_amount
    #[flow]
    fn flow_deposit_after_stream_ends(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }
        // Need a completed-but-uncheckpointed stream
        if self.vault.stream_amount == 0 || self.vault.clock < self.vault.stream_end {
            return;
        }

        let user_idx = random_user();
        if !self.vault.is_user_allowed(user_idx) {
            return;
        }

        let effective = self.vault.effective_total_assets();
        let expected_effective = self.vault.base_assets.saturating_add(self.vault.stream_amount);

        assert_eq!(
            effective, expected_effective,
            "Post-stream effective {} != base + stream {} before checkpoint",
            effective, expected_effective
        );

        let assets: u64 = (rand::random::<u64>() % 10_000_000).max(1000);

        let shares = match convert_to_shares(
            assets,
            effective,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares == 0 {
            return;
        }

        // Deposit uses effective (includes full stream) for pricing
        self.vault.base_assets = self.vault.base_assets.saturating_add(assets);
        self.vault.total_shares = self.vault.total_shares.saturating_add(shares);
        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault.users[user_idx].cumulative_deposited += assets as u128;
        self.vault.deposit_count += 1;
        self.vault.total_deposited += assets as u128;
    }

    /// Withdraw (not redeem) mid-stream — uses effective_total_assets for pricing
    #[flow]
    fn flow_withdraw_during_stream(&mut self) {
        if !self.vault.initialized || !self.vault.has_active_stream() || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        if !self.vault.is_user_allowed(user_idx) || self.vault.is_user_locked(user_idx) {
            return;
        }

        let user_shares = self.vault.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        // Withdraw specifies assets, compute shares needed
        let effective = self.vault.effective_total_assets();
        let desired_assets: u64 = (rand::random::<u64>() % (effective / 10).max(1)).max(100);

        if desired_assets > self.vault.base_assets {
            return;
        }

        // Convert assets to shares needed (round up for vault protection)
        let shares_needed = match convert_to_shares(
            desired_assets,
            effective,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Ceiling,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares_needed == 0 || shares_needed > user_shares {
            return;
        }

        let price_before = self.vault.share_price_x1e18();

        self.vault.base_assets = self.vault.base_assets.saturating_sub(desired_assets);
        self.vault.total_shares = self.vault.total_shares.saturating_sub(shares_needed);
        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_sub(shares_needed);
        self.vault.users[user_idx].cumulative_redeemed += desired_assets as u128;
        self.vault.total_withdrawn += desired_assets as u128;
        self.vault.total_redeemed += desired_assets as u128;

        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after withdraw during stream: {} -> {}",
            price_before,
            price_after
        );
    }

    /// Mint exact shares mid-stream — pricing uses interpolated balance
    #[flow]
    fn flow_mint_during_stream(&mut self) {
        if !self.vault.initialized || !self.vault.has_active_stream() || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        if !self.vault.is_user_allowed(user_idx) {
            return;
        }

        let effective = self.vault.effective_total_assets();

        // Mint specifies shares, compute assets needed
        let desired_shares: u64 = (rand::random::<u64>() % 10_000_000).max(100);

        // Convert shares to assets needed (round up for vault protection)
        let assets_needed = match convert_to_assets(
            desired_shares,
            effective,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Ceiling,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets_needed == 0 {
            return;
        }

        let price_before = self.vault.share_price_x1e18();

        self.vault.base_assets = self.vault.base_assets.saturating_add(assets_needed);
        self.vault.total_shares = self.vault.total_shares.saturating_add(desired_shares);
        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(desired_shares);
        self.vault.users[user_idx].cumulative_deposited += assets_needed as u128;
        self.vault.deposit_count += 1;
        self.vault.total_deposited += assets_needed as u128;

        if self.vault.lock_config.enabled {
            self.vault.users[user_idx].locked_until =
                self.vault.clock + self.vault.lock_config.lock_duration;
        }

        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after mint during stream: {} -> {}",
            price_before,
            price_after
        );
    }

    // =========================================================================
    // Edge cases
    // =========================================================================

    #[flow]
    fn flow_zero_edge_cases(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let effective = self.vault.effective_total_assets();

        let zero_shares = convert_to_shares(
            0,
            effective,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);
        assert_eq!(zero_shares, 0, "Zero deposit yielded non-zero shares");

        let zero_assets = convert_to_assets(
            0,
            effective,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);
        assert_eq!(zero_assets, 0, "Zero shares yielded non-zero assets");
    }

    #[flow]
    fn flow_view_invariants_during_stream(&mut self) {
        if !self.vault.initialized || !self.vault.has_active_stream() {
            return;
        }

        let effective = self.vault.effective_total_assets();

        // effective >= base_assets always
        assert!(
            effective >= self.vault.base_assets,
            "View invariant: effective {} < base {}",
            effective,
            self.vault.base_assets
        );

        // effective <= base_assets + stream_amount
        let max_effective = self.vault.base_assets.saturating_add(self.vault.stream_amount);
        assert!(
            effective <= max_effective,
            "View invariant: effective {} > base + stream {}",
            effective,
            max_effective
        );

        // STRICT mid-stream bounds: if elapsed > 0 && elapsed < duration,
        // effective must be strictly between base and base+stream
        let elapsed = self.vault.clock - self.vault.stream_start;
        let duration = self.vault.stream_end - self.vault.stream_start;
        if elapsed > 0 && elapsed < duration && self.vault.stream_amount > 0 {
            assert!(
                effective > self.vault.base_assets,
                "Strict mid-stream: effective {} should be > base {} (elapsed={}, duration={})",
                effective,
                self.vault.base_assets,
                elapsed,
                duration
            );
            assert!(
                effective < max_effective,
                "Strict mid-stream: effective {} should be < base+stream {} (elapsed={}, duration={})",
                effective,
                max_effective,
                elapsed,
                duration
            );
        }

        // Round-trip conversion loss: convertToShares(convertToAssets(x)) <= x
        if self.vault.total_shares > 0 && effective > 0 {
            let test_shares: u64 = (rand::random::<u64>() % self.vault.total_shares).max(1);
            let assets = convert_to_assets(
                test_shares,
                effective,
                self.vault.total_shares,
                self.vault.decimals_offset,
                Rounding::Floor,
            )
            .unwrap_or(0);

            if assets > 0 {
                let shares_back = convert_to_shares(
                    assets,
                    effective,
                    self.vault.total_shares,
                    self.vault.decimals_offset,
                    Rounding::Floor,
                )
                .unwrap_or(0);

                assert!(
                    shares_back <= test_shares,
                    "Round-trip conversion created shares: {} -> {} assets -> {} shares",
                    test_shares,
                    assets,
                    shares_back
                );
            }
        }
    }

    // =========================================================================
    // Phase 2A: Fee module
    // =========================================================================

    #[flow]
    fn flow_init_fees(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let entry_bps = rand::random::<u16>() % 1500;
        let exit_bps = rand::random::<u16>() % 1500;

        let entry_valid = validate_entry_fee(entry_bps).is_ok();
        let exit_valid = validate_exit_fee(exit_bps).is_ok();

        if entry_bps > MAX_ENTRY_FEE_BPS {
            assert!(!entry_valid, "Should reject entry fee > MAX");
        }
        if exit_bps > MAX_EXIT_FEE_BPS {
            assert!(!exit_valid, "Should reject exit fee > MAX");
        }

        if entry_valid && exit_valid {
            self.vault.fee_config = FeeConfig {
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
        if !self.vault.initialized {
            return;
        }

        let global_cap = (rand::random::<u64>() % 10_000_000_000).max(100_000);
        let per_user_cap = (rand::random::<u64>() % global_cap).max(10_000);

        self.vault.cap_config = CapConfig {
            enabled: true,
            global_cap,
            per_user_cap,
        };
    }

    #[flow]
    fn flow_deposit_exceeds_global_cap(&mut self) {
        if !self.vault.initialized
            || !self.vault.cap_config.enabled
            || self.vault.paused
        {
            return;
        }

        let effective = self.vault.effective_total_assets();
        let remaining = self.vault.cap_config.global_cap.saturating_sub(effective);
        if remaining == 0 {
            return;
        }

        let excess = remaining.saturating_add((rand::random::<u64>() % 1_000_000).max(1));
        let would_exceed = effective.saturating_add(excess) > self.vault.cap_config.global_cap;

        assert!(would_exceed, "Deposit should exceed global cap");
        // Blocked — no state change
    }

    #[flow]
    fn flow_deposit_at_cap_boundary(&mut self) {
        if !self.vault.initialized
            || !self.vault.cap_config.enabled
            || self.vault.paused
        {
            return;
        }

        let effective = self.vault.effective_total_assets();
        let remaining = self.vault.cap_config.global_cap.saturating_sub(effective);
        if remaining < 1000 {
            return;
        }

        let assets = remaining;
        let user_idx = random_user();

        let shares = match convert_to_shares(
            assets,
            effective,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        self.vault.base_assets = self.vault.base_assets.saturating_add(assets);
        self.vault.total_shares = self.vault.total_shares.saturating_add(shares);
        self.vault.deposit_count += 1;
        self.vault.total_deposited += assets as u128;

        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault.users[user_idx].cumulative_deposited += assets as u128;

        // INVARIANT: effective total <= global cap
        let new_effective = self.vault.effective_total_assets();
        assert!(
            new_effective <= self.vault.cap_config.global_cap.saturating_add(self.vault.stream_amount),
            "Effective {} exceeded global cap {} (stream {})",
            new_effective,
            self.vault.cap_config.global_cap,
            self.vault.stream_amount
        );
    }

    // =========================================================================
    // Phase 2C: Lock module
    // =========================================================================

    #[flow]
    fn flow_init_locks(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let duration = (rand::random::<i64>().abs() % 86400 * 30).max(3600);
        self.vault.lock_config = LockConfig {
            enabled: true,
            lock_duration: duration,
        };
    }

    #[flow]
    fn flow_redeem_while_locked(&mut self) {
        if !self.vault.initialized || !self.vault.lock_config.enabled {
            return;
        }

        let user_idx = random_user();
        if !self.vault.is_user_locked(user_idx) {
            return;
        }

        let user_shares = self.vault.users[user_idx].shares_balance;
        let shares_before = self.vault.total_shares;

        // Verify no state change (lock prevents redemption)
        assert_eq!(
            self.vault.total_shares, shares_before,
            "Locked user was able to redeem"
        );
        assert_eq!(
            self.vault.users[user_idx].shares_balance, user_shares,
            "Locked user's balance changed"
        );
    }

    // =========================================================================
    // Phase 2D: Access control module
    // =========================================================================

    #[flow]
    fn flow_init_access_whitelist(&mut self) {
        if !self.vault.initialized {
            return;
        }

        self.vault.access_config = AccessConfig {
            enabled: true,
            mode: AccessMode::Whitelist,
        };

        for i in 0..NUM_USERS {
            self.vault.users[i].whitelisted = rand::random::<bool>();
            self.vault.users[i].blacklisted = false;
            self.vault.users[i].frozen = false;
        }
    }

    #[flow]
    fn flow_init_access_blacklist(&mut self) {
        if !self.vault.initialized {
            return;
        }

        self.vault.access_config = AccessConfig {
            enabled: true,
            mode: AccessMode::Blacklist,
        };

        for i in 0..NUM_USERS {
            self.vault.users[i].blacklisted = rand::random::<bool>();
            self.vault.users[i].whitelisted = false;
            self.vault.users[i].frozen = false;
        }
    }

    #[flow]
    fn flow_freeze_user(&mut self) {
        if !self.vault.initialized || !self.vault.access_config.enabled {
            return;
        }

        let user_idx = random_user();
        self.vault.users[user_idx].frozen = true;
    }

    #[flow]
    fn flow_frozen_user_blocked(&mut self) {
        if !self.vault.initialized || !self.vault.access_config.enabled {
            return;
        }

        let user_idx = random_user();
        if !self.vault.users[user_idx].frozen {
            return;
        }

        assert!(
            !self.vault.is_user_allowed(user_idx),
            "Frozen user should not be allowed"
        );
    }

    // =========================================================================
    // End invariants
    // =========================================================================

    #[end]
    fn end(&mut self) {
        if !self.vault.initialized {
            return;
        }

        // INVARIANT: effective_total_assets >= base_assets
        let effective = self.vault.effective_total_assets();
        assert!(
            effective >= self.vault.base_assets,
            "Final: effective_total_assets {} < base_assets {}",
            effective,
            self.vault.base_assets
        );

        // INVARIANT: User shares sum + unassigned (fees) == total shares
        let user_total = self.vault.total_user_shares();
        let unassigned = self.vault.total_shares.saturating_sub(user_total);
        assert!(
            unassigned as u128 <= self.vault.cumulative_fees_collected,
            "Final: unassigned shares {} exceed total fees collected {}",
            unassigned,
            self.vault.cumulative_fees_collected
        );

        // INVARIANT: Total redeemed <= total deposited + yield capacity
        assert!(
            self.vault.total_redeemed
                <= self
                    .vault
                    .total_deposited
                    .saturating_add(self.vault.stream_amount as u128)
                    .saturating_add(self.vault.base_assets as u128),
            "Final: total_redeemed {} exceeds deposited {} + yield capacity",
            self.vault.total_redeemed,
            self.vault.total_deposited
        );

        // INVARIANT: No user redeemed more than deposited (within rounding)
        for (i, user) in self.vault.users.iter().enumerate() {
            assert!(
                user.cumulative_redeemed <= user.cumulative_deposited.saturating_add(1000),
                "Final: user {} redeemed {} > deposited {} (free money)",
                i,
                user.cumulative_redeemed,
                user.cumulative_deposited
            );
        }

        // INVARIANT: If stream completed, effective == base + stream
        if self.vault.stream_amount > 0 && self.vault.clock >= self.vault.stream_end {
            let fully_streamed = self.vault.base_assets.saturating_add(self.vault.stream_amount);
            assert_eq!(
                effective, fully_streamed,
                "Final: after full stream, effective {} != base + stream {}",
                effective, fully_streamed
            );
        }

        // INVARIANT: Cap not exceeded
        if self.vault.cap_config.enabled {
            // base_assets (excluding stream) should be within cap
            assert!(
                self.vault.base_assets
                    <= self.vault.cap_config.global_cap.saturating_add(self.vault.stream_amount),
                "Final: base_assets {} exceed global cap {} + stream {}",
                self.vault.base_assets,
                self.vault.cap_config.global_cap,
                self.vault.stream_amount
            );
        }

        // INVARIANT: Checkpoint idempotency
        let _checkpoint_before = self.vault.clone();
        self.vault.checkpoint();
        let checkpoint_after_first = self.vault.clone();
        self.vault.checkpoint();

        assert_eq!(
            checkpoint_after_first.base_assets, self.vault.base_assets,
            "Final: checkpoint not idempotent at same timestamp: first={}, second={}",
            checkpoint_after_first.base_assets, self.vault.base_assets
        );
        assert_eq!(
            checkpoint_after_first.stream_amount, self.vault.stream_amount,
            "Final: checkpoint stream_amount changed on second call: first={}, second={}",
            checkpoint_after_first.stream_amount, self.vault.stream_amount
        );

        // INVARIANT: Significant shares require assets
        if self.vault.total_shares > 1000 {
            assert!(
                effective > 0,
                "Final: significant shares exist but no effective assets"
            );
        }

        // INVARIANT: Total withdrawn never exceeds vault balance
        // (total deposited + total stream yield is the max possible balance)
        assert!(
            self.vault.total_withdrawn
                <= self.vault.total_deposited.saturating_add(self.vault.stream_amount as u128),
            "Final: total_withdrawn {} exceeds total deposits {} + stream yield {}",
            self.vault.total_withdrawn,
            self.vault.total_deposited,
            self.vault.stream_amount
        );

        // INVARIANT: After stream fully elapses + checkpoint, base == original_base + stream
        if self.vault.stream_amount > 0 && self.vault.clock >= self.vault.stream_end {
            let pre_checkpoint_base = self.vault.base_assets;
            let pre_checkpoint_stream = self.vault.stream_amount;
            let mut check_vault = self.vault.clone();
            check_vault.checkpoint();
            assert_eq!(
                check_vault.base_assets,
                pre_checkpoint_base.saturating_add(pre_checkpoint_stream),
                "Final: post-checkpoint base {} != pre-base {} + stream {}",
                check_vault.base_assets,
                pre_checkpoint_base,
                pre_checkpoint_stream
            );
            assert_eq!(
                check_vault.stream_amount, 0,
                "Final: stream_amount should be 0 after checkpoint of completed stream"
            );
        }

        // INVARIANT: Share price after stream >= price before stream (no deposits between)
        // This uses the price snapshot taken at distribute_yield time
        if self.vault.price_before_stream > 0 && self.vault.total_shares > 0 {
            let current_price = self.vault.share_price_x1e18();
            assert!(
                current_price >= self.vault.price_before_stream,
                "Final: share price decreased from stream start {} to end {}",
                self.vault.price_before_stream,
                current_price
            );
        }
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}
