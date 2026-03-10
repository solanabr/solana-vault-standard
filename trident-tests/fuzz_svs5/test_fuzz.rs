use fuzz_accounts::*;
use svs_math::{convert_to_assets, convert_to_shares, mul_div, Rounding};
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;

const NUM_USERS: usize = 4;

#[derive(Default, Clone, Copy)]
struct UserState {
    shares_balance: u64,
    cumulative_deposited: u128,
    cumulative_redeemed: u128,
}

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
    users: [UserState; NUM_USERS],
    deposit_count: u64,
    redeem_count: u64,
    total_deposited: u128,
    total_redeemed: u128,
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
            users: [UserState::default(); NUM_USERS],
            deposit_count: 0,
            redeem_count: 0,
            total_deposited: 0,
            total_redeemed: 0,
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

    fn total_user_shares(&self) -> u64 {
        self.users
            .iter()
            .fold(0u64, |acc, u| acc.saturating_add(u.shares_balance))
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
        if !self.vault.initialized {
            return;
        }

        let user_idx = random_user();
        let assets: u64 = (rand::random::<u64>() % 100_000_000).max(1000);

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
    }

    #[flow]
    fn flow_redeem(&mut self) {
        if !self.vault.initialized || self.vault.total_shares == 0 {
            return;
        }

        let user_idx = random_user();
        let user_shares = self.vault.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % user_shares).max(1);

        // SVS-5: Auto-checkpoint before redeem (matches on-chain behavior)
        self.vault.checkpoint();

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

        self.vault.base_assets = self.vault.base_assets.saturating_sub(assets);

        self.vault.total_shares = self.vault.total_shares.saturating_sub(shares);
        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_sub(shares);
        self.vault.users[user_idx].cumulative_redeemed += assets as u128;
        self.vault.redeem_count += 1;
        self.vault.total_redeemed += assets as u128;
    }

    #[flow]
    fn flow_distribute_yield(&mut self) {
        if !self.vault.initialized {
            return;
        }

        if self.vault.has_active_stream() {
            self.vault.checkpoint();
        }

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
        if !self.vault.initialized || !self.vault.has_active_stream() {
            return;
        }

        let user_idx = random_user();
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

        let rounding_loss = assets - assets_back;
        self.vault.users[user_idx].cumulative_deposited += assets as u128;
        self.vault.users[user_idx].cumulative_redeemed += assets_back as u128;
        self.vault.deposit_count += 1;
        self.vault.redeem_count += 1;
        self.vault.total_deposited += assets as u128;
        self.vault.total_redeemed += assets_back as u128;

        // rounding_loss stays in the vault via base_assets (already reflected by the sub above)
    }

    #[end]
    fn end(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let effective = self.vault.effective_total_assets();
        assert!(
            effective >= self.vault.base_assets,
            "Final: effective_total_assets {} < base_assets {}",
            effective,
            self.vault.base_assets
        );

        let user_total = self.vault.total_user_shares();
        assert_eq!(
            user_total, self.vault.total_shares,
            "Final: user shares sum {} != total_shares {}",
            user_total, self.vault.total_shares
        );

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

        if self.vault.stream_amount > 0 && self.vault.clock >= self.vault.stream_end {
            let fully_streamed = self.vault.base_assets.saturating_add(self.vault.stream_amount);
            assert_eq!(
                effective, fully_streamed,
                "Final: after full stream, effective {} != base + stream {}",
                effective, fully_streamed
            );
        }

        let checkpoint_before = self.vault.clone();
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
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}
