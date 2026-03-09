use fuzz_accounts::*;
use svs_math::{convert_to_assets, convert_to_shares, Rounding};
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;

const NUM_USERS: usize = 5;

/// SVS-2 vault tracker: models stored balance vs actual balance divergence.
///
/// In SVS-2, `stored_total_assets` is updated only on deposit/withdraw/sync,
/// while `actual_balance` changes on every token transfer (including external
/// yield deposits). Share conversions always use `stored_total_assets`.
#[derive(Default, Clone)]
struct SVS2VaultTracker {
    initialized: bool,
    stored_total_assets: u64,
    actual_balance: u64,
    total_shares: u64,
    decimals_offset: u8,
    deposit_count: u64,
    redeem_count: u64,
    total_deposited: u128,
    total_redeemed: u128,
    users: [SVS2UserState; NUM_USERS],
    sync_count: u64,
}

#[derive(Default, Clone, Copy)]
struct SVS2UserState {
    shares_balance: u64,
    cumulative_deposited: u128,
    cumulative_redeemed: u128,
}

impl SVS2VaultTracker {
    fn user_shares_sum(&self) -> u64 {
        self.users
            .iter()
            .fold(0u64, |acc, u| acc.saturating_add(u.shares_balance))
    }
}

fn random_user() -> usize {
    rand::random::<usize>() % NUM_USERS
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    vault_tracker: SVS2VaultTracker,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            vault_tracker: SVS2VaultTracker::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        self.vault_tracker = SVS2VaultTracker::default();
    }

    #[flow]
    fn flow_initialize(&mut self) {
        if self.vault_tracker.initialized {
            return;
        }
        let fuzz_decimals: u8 = rand::random::<u8>() % 10;
        self.vault_tracker.decimals_offset = fuzz_decimals;
        self.vault_tracker.initialized = true;
    }

    /// Deposit: updates both stored and actual balance.
    #[flow]
    fn flow_deposit(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 1_000_000_000_000).max(1000);
        let user_idx = random_user();

        // Share conversion uses STORED total_assets (SVS-2 rule)
        let shares = match convert_to_shares(
            assets,
            self.vault_tracker.stored_total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        self.vault_tracker.stored_total_assets = self
            .vault_tracker
            .stored_total_assets
            .saturating_add(assets);
        self.vault_tracker.actual_balance =
            self.vault_tracker.actual_balance.saturating_add(assets);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_add(shares);
        self.vault_tracker.deposit_count += 1;
        self.vault_tracker.total_deposited += assets as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault_tracker.users[user_idx].cumulative_deposited += assets as u128;

        // After deposit: stored == actual (deposit updates both)
        // Only true if no external yield has been added since last sync
        // Actually: stored and actual both increase by the same amount, so the gap stays.
        // stored <= actual always holds.
        assert!(
            self.vault_tracker.stored_total_assets <= self.vault_tracker.actual_balance,
            "stored {} > actual {} after deposit",
            self.vault_tracker.stored_total_assets,
            self.vault_tracker.actual_balance
        );
    }

    /// Redeem: updates both stored and actual balance.
    #[flow]
    fn flow_redeem(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.total_shares == 0 {
            return;
        }

        let user_idx = random_user();
        let user_shares = self.vault_tracker.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % user_shares).max(1);

        // Conversion uses STORED total_assets
        let assets = match convert_to_assets(
            shares,
            self.vault_tracker.stored_total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        // Must have enough actual balance to transfer
        if assets > self.vault_tracker.actual_balance {
            return;
        }
        if assets > self.vault_tracker.stored_total_assets {
            return;
        }

        self.vault_tracker.stored_total_assets = self
            .vault_tracker
            .stored_total_assets
            .saturating_sub(assets);
        self.vault_tracker.actual_balance =
            self.vault_tracker.actual_balance.saturating_sub(assets);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_sub(shares);
        self.vault_tracker.redeem_count += 1;
        self.vault_tracker.total_redeemed += assets as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_sub(shares);
        self.vault_tracker.users[user_idx].cumulative_redeemed += assets as u128;

        assert!(
            self.vault_tracker.stored_total_assets <= self.vault_tracker.actual_balance,
            "stored {} > actual {} after redeem",
            self.vault_tracker.stored_total_assets,
            self.vault_tracker.actual_balance
        );
    }

    /// External yield: increases actual_balance WITHOUT updating stored.
    /// Simulates yield accrual (e.g., lending protocol returns, staking rewards).
    #[flow]
    fn flow_external_yield(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let yield_amount: u64 = (rand::random::<u64>() % 10_000_000).max(1);
        self.vault_tracker.actual_balance = self
            .vault_tracker
            .actual_balance
            .saturating_add(yield_amount);

        // stored stays the same — divergence grows
        assert!(
            self.vault_tracker.stored_total_assets <= self.vault_tracker.actual_balance,
            "stored > actual after yield"
        );
    }

    /// Sync: sets stored = actual, recognizing all accrued yield.
    #[flow]
    fn flow_sync(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        self.vault_tracker.stored_total_assets = self.vault_tracker.actual_balance;
        self.vault_tracker.sync_count += 1;

        assert_eq!(
            self.vault_tracker.stored_total_assets, self.vault_tracker.actual_balance,
            "stored != actual after sync"
        );
    }

    /// Deposit before sync: uses stale stored value for conversion.
    /// This is correct SVS-2 behavior — yield only recognized after sync.
    #[flow]
    fn flow_deposit_before_sync(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let gap = self
            .vault_tracker
            .actual_balance
            .saturating_sub(self.vault_tracker.stored_total_assets);
        if gap == 0 {
            return; // No pending yield, same as normal deposit
        }

        let assets: u64 = (rand::random::<u64>() % 100_000_000).max(1000);
        let user_idx = random_user();

        // Uses stored (stale) value — depositor gets MORE shares per asset
        // because share price appears lower (unrecognized yield)
        let shares_stale = match convert_to_shares(
            assets,
            self.vault_tracker.stored_total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        // For comparison: what would they get post-sync?
        let shares_fresh = convert_to_shares(
            assets,
            self.vault_tracker.actual_balance,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);

        // INVARIANT: Depositing before sync gives >= shares vs after sync
        // (stale price is lower, so more shares per asset)
        assert!(
            shares_stale >= shares_fresh,
            "Stale deposit gave fewer shares ({}) than fresh ({}), gap={}",
            shares_stale,
            shares_fresh,
            gap
        );

        self.vault_tracker.stored_total_assets = self
            .vault_tracker
            .stored_total_assets
            .saturating_add(assets);
        self.vault_tracker.actual_balance =
            self.vault_tracker.actual_balance.saturating_add(assets);
        self.vault_tracker.total_shares =
            self.vault_tracker.total_shares.saturating_add(shares_stale);
        self.vault_tracker.deposit_count += 1;
        self.vault_tracker.total_deposited += assets as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_add(shares_stale);
        self.vault_tracker.users[user_idx].cumulative_deposited += assets as u128;
    }

    /// Sync then redeem: after sync, share price reflects yield, so
    /// redeeming gives more assets per share.
    #[flow]
    fn flow_sync_then_redeem(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.total_shares == 0 {
            return;
        }

        let gap = self
            .vault_tracker
            .actual_balance
            .saturating_sub(self.vault_tracker.stored_total_assets);
        if gap == 0 {
            return;
        }

        let user_idx = random_user();
        let user_shares = self.vault_tracker.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        // Assets per share BEFORE sync
        let assets_before_sync = convert_to_assets(
            user_shares,
            self.vault_tracker.stored_total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);

        // Sync
        self.vault_tracker.stored_total_assets = self.vault_tracker.actual_balance;
        self.vault_tracker.sync_count += 1;

        // Assets per share AFTER sync
        let assets_after_sync = convert_to_assets(
            user_shares,
            self.vault_tracker.stored_total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        )
        .unwrap_or(0);

        // INVARIANT: Post-sync redemption value >= pre-sync (yield was recognized)
        assert!(
            assets_after_sync >= assets_before_sync,
            "Sync decreased redemption value: {} -> {}, gap={}",
            assets_before_sync,
            assets_after_sync,
            gap
        );

        // Actually redeem
        let shares = (rand::random::<u64>() % user_shares).max(1);
        let assets = match convert_to_assets(
            shares,
            self.vault_tracker.stored_total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets > self.vault_tracker.actual_balance {
            return;
        }

        self.vault_tracker.stored_total_assets = self
            .vault_tracker
            .stored_total_assets
            .saturating_sub(assets);
        self.vault_tracker.actual_balance =
            self.vault_tracker.actual_balance.saturating_sub(assets);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_sub(shares);
        self.vault_tracker.redeem_count += 1;
        self.vault_tracker.total_redeemed += assets as u128;

        self.vault_tracker.users[user_idx].shares_balance = self.vault_tracker.users[user_idx]
            .shares_balance
            .saturating_sub(shares);
        self.vault_tracker.users[user_idx].cumulative_redeemed += assets as u128;
    }

    #[end]
    fn end(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        // INVARIANT: stored <= actual (vault never reports phantom assets)
        assert!(
            self.vault_tracker.stored_total_assets <= self.vault_tracker.actual_balance,
            "Final: stored {} > actual {}",
            self.vault_tracker.stored_total_assets,
            self.vault_tracker.actual_balance
        );

        // INVARIANT: Total redeemed <= total deposited + yield
        // yield = actual - stored at init was 0, so total yield received = actual - stored + redeemed - deposited ...
        // Simpler: redeemed <= deposited + all external yield
        assert!(
            self.vault_tracker.total_redeemed <= self.vault_tracker.total_deposited
                + self.vault_tracker.actual_balance as u128,
            "Final: redeemed more than deposited + yield"
        );

        // INVARIANT: Share accounting
        let user_sum = self.vault_tracker.user_shares_sum();
        assert_eq!(
            user_sum, self.vault_tracker.total_shares,
            "Final: user shares sum {} != total_shares {}",
            user_sum, self.vault_tracker.total_shares
        );

        // INVARIANT: Significant shares require assets
        if self.vault_tracker.total_shares > 1000 {
            assert!(
                self.vault_tracker.actual_balance > 0,
                "Final: significant shares but no actual balance"
            );
        }
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}
