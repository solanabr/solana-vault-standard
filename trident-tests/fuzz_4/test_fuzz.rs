use fuzz_accounts::*;
use svs_math::{convert_to_assets, convert_to_shares, Rounding};
use svs_oracle::{
    assets_to_shares as oracle_assets_to_shares, shares_to_assets as oracle_shares_to_assets,
    validate_oracle, validate_staleness_config, PRICE_SCALE,
};
use trident_fuzz::fuzzing::*;

mod fuzz_accounts;

const NUM_USERS: usize = 5;
const MIN_ASSETS: u64 = 1_000;
const DEFAULT_MAX_STALENESS: i64 = 3_600;
const DEFAULT_REQUEST_EXPIRY: i64 = 7_200;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum RequestStatus {
    #[default]
    Pending,
    Fulfilled,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DepositRequestState {
    receiver: usize,
    assets_locked: u64,
    shares_claimable: u64,
    status: RequestStatus,
    requested_at: i64,
    fulfilled_at: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct RedeemRequestState {
    receiver: usize,
    shares_locked: u64,
    assets_claimable: u64,
    status: RequestStatus,
    requested_at: i64,
    fulfilled_at: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct AsyncUserState {
    liquid_shares: u64,
    operator_approved: bool,
    cumulative_redeemed_assets: u128,
    deposit_request: Option<DepositRequestState>,
    redeem_request: Option<RedeemRequestState>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct AsyncVaultTracker {
    initialized: bool,
    paused: bool,
    decimals_offset: u8,
    operator_idx: usize,
    total_assets: u64,
    total_shares: u64,
    pending_deposit_assets: u64,
    pending_claim_shares: u64,
    asset_vault_balance: u64,
    share_escrow_balance: u64,
    max_staleness: i64,
    request_expiry_secs: i64,
    clock: i64,
    cumulative_requested_assets: u128,
    cumulative_cancelled_assets: u128,
    cumulative_claimed_redeem_assets: u128,
    users: [AsyncUserState; NUM_USERS],
}

impl AsyncVaultTracker {
    fn expected_vault_price(&self) -> u64 {
        if self.total_shares == 0 {
            return PRICE_SCALE;
        }

        let price = (self.total_assets.max(1) as u128)
            .checked_mul(PRICE_SCALE as u128)
            .and_then(|v| v.checked_div(self.total_shares as u128))
            .unwrap_or(PRICE_SCALE as u128);

        if price == 0 {
            1
        } else if price > u64::MAX as u128 {
            u64::MAX
        } else {
            price as u64
        }
    }

    fn minted_supply(&self) -> u64 {
        self.users.iter().fold(self.share_escrow_balance, |acc, user| {
            acc.saturating_add(user.liquid_shares)
        })
    }

    fn pending_deposit_sum(&self) -> u64 {
        self.users
            .iter()
            .filter_map(|user| user.deposit_request)
            .filter(|request| request.status == RequestStatus::Pending)
            .fold(0u64, |acc, request| {
                acc.saturating_add(request.assets_locked)
            })
    }

    fn pending_claim_sum(&self) -> u64 {
        self.users
            .iter()
            .filter_map(|user| user.deposit_request)
            .filter(|request| request.status == RequestStatus::Fulfilled)
            .fold(0u64, |acc, request| {
                acc.saturating_add(request.shares_claimable)
            })
    }

    fn pending_redeem_shares_sum(&self) -> u64 {
        self.users
            .iter()
            .filter_map(|user| user.redeem_request)
            .filter(|request| request.status == RequestStatus::Pending)
            .fold(0u64, |acc, request| {
                acc.saturating_add(request.shares_locked)
            })
    }

    fn claimable_redeem_assets_sum(&self) -> u64 {
        self.users
            .iter()
            .filter_map(|user| user.redeem_request)
            .filter(|request| request.status == RequestStatus::Fulfilled)
            .fold(0u64, |acc, request| {
                acc.saturating_add(request.assets_claimable)
            })
    }

    fn liquid_share_sum(&self) -> u64 {
        self.users
            .iter()
            .fold(0u64, |acc, user| acc.saturating_add(user.liquid_shares))
    }

    fn claim_authorized(&self, owner_idx: usize, receiver_idx: usize, claimant_idx: usize) -> bool {
        claimant_idx == owner_idx
            || claimant_idx == receiver_idx
            || (claimant_idx == self.operator_idx && self.users[owner_idx].operator_approved)
    }

    fn assert_invariants(&self) {
        if !self.initialized {
            return;
        }

        assert_eq!(
            self.pending_deposit_assets,
            self.pending_deposit_sum(),
            "pending deposit aggregate mismatch"
        );
        assert_eq!(
            self.pending_claim_shares,
            self.pending_claim_sum(),
            "pending claim aggregate mismatch"
        );
        assert_eq!(
            self.share_escrow_balance,
            self.pending_redeem_shares_sum(),
            "share escrow mismatch"
        );
        assert_eq!(
            self.asset_vault_balance,
            self.total_assets
                .checked_add(self.pending_deposit_assets)
                .unwrap_or(u64::MAX),
            "asset vault isolation invariant broken"
        );
        assert_eq!(
            self.total_shares,
            self.minted_supply()
                .checked_add(self.pending_claim_shares)
                .unwrap_or(u64::MAX),
            "economic supply invariant broken"
        );
        assert_eq!(
            self.liquid_share_sum()
                .checked_add(self.share_escrow_balance)
                .unwrap_or(u64::MAX),
            self.minted_supply(),
            "minted supply accounting mismatch"
        );

        let claimable_assets = self.claimable_redeem_assets_sum() as u128;
        let accounted_assets = self.asset_vault_balance as u128
            + claimable_assets
            + self.cumulative_cancelled_assets
            + self.cumulative_claimed_redeem_assets;
        assert_eq!(
            accounted_assets,
            self.cumulative_requested_assets,
            "asset conservation mismatch"
        );

        for (idx, user) in self.users.iter().enumerate() {
            if let Some(request) = user.deposit_request {
                assert!(
                    request.requested_at <= self.clock,
                    "deposit request {} created in the future",
                    idx
                );
                if request.status == RequestStatus::Fulfilled {
                    assert!(
                        request.fulfilled_at >= request.requested_at,
                        "deposit request {} fulfilled before request",
                        idx
                    );
                }
            }

            if let Some(request) = user.redeem_request {
                assert!(
                    request.requested_at <= self.clock,
                    "redeem request {} created in the future",
                    idx
                );
                if request.status == RequestStatus::Fulfilled {
                    assert!(
                        request.fulfilled_at >= request.requested_at,
                        "redeem request {} fulfilled before request",
                        idx
                    );
                }
            }
        }
    }
}

fn random_user() -> usize {
    rand::random::<usize>() % NUM_USERS
}

fn random_receiver() -> usize {
    rand::random::<usize>() % NUM_USERS
}

fn random_assets() -> u64 {
    (rand::random::<u64>() % 1_000_000_000).max(MIN_ASSETS)
}

fn random_claimant(owner_idx: usize, receiver_idx: usize, operator_idx: usize) -> usize {
    match rand::random::<u8>() % 4 {
        0 => owner_idx,
        1 => receiver_idx,
        2 => operator_idx,
        _ => random_user(),
    }
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    vault_tracker: AsyncVaultTracker,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            vault_tracker: AsyncVaultTracker::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        self.vault_tracker = AsyncVaultTracker::default();
    }

    #[flow]
    fn flow_initialize(&mut self) {
        if self.vault_tracker.initialized {
            return;
        }

        let max_staleness = DEFAULT_MAX_STALENESS;
        if validate_staleness_config(max_staleness).is_err() {
            return;
        }

        self.vault_tracker.initialized = true;
        self.vault_tracker.decimals_offset = rand::random::<u8>() % 10;
        self.vault_tracker.operator_idx = random_user();
        self.vault_tracker.max_staleness = max_staleness;
        self.vault_tracker.request_expiry_secs = DEFAULT_REQUEST_EXPIRY;
        self.vault_tracker.clock = 1_000_000;
        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_pause(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        self.vault_tracker.paused = true;
        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_unpause(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        self.vault_tracker.paused = false;
        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_advance_clock(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let delta = 1 + i64::from(rand::random::<u16>() % 12_000);
        self.vault_tracker.clock = self.vault_tracker.clock.saturating_add(delta);
        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_set_operator_approval(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let owner_idx = random_user();
        if owner_idx == self.vault_tracker.operator_idx {
            return;
        }

        self.vault_tracker.users[owner_idx].operator_approved = rand::random::<bool>();
        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_request_deposit(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let owner_idx = random_user();
        if self.vault_tracker.users[owner_idx].deposit_request.is_some() {
            return;
        }

        let assets = random_assets();
        let receiver_idx = random_receiver();

        let request = DepositRequestState {
            receiver: receiver_idx,
            assets_locked: assets,
            shares_claimable: 0,
            status: RequestStatus::Pending,
            requested_at: self.vault_tracker.clock,
            fulfilled_at: 0,
        };

        self.vault_tracker.users[owner_idx].deposit_request = Some(request);
        self.vault_tracker.pending_deposit_assets = self
            .vault_tracker
            .pending_deposit_assets
            .checked_add(assets)
            .unwrap_or(self.vault_tracker.pending_deposit_assets);
        self.vault_tracker.asset_vault_balance = self
            .vault_tracker
            .asset_vault_balance
            .checked_add(assets)
            .unwrap_or(self.vault_tracker.asset_vault_balance);
        self.vault_tracker.cumulative_requested_assets = self
            .vault_tracker
            .cumulative_requested_assets
            .checked_add(assets as u128)
            .unwrap_or(self.vault_tracker.cumulative_requested_assets);

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_request_deposit_twice_attack(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let owner_idx = random_user();
        if self.vault_tracker.users[owner_idx].deposit_request.is_none() {
            return;
        }

        let before = self.vault_tracker.clone();
        assert_eq!(
            self.vault_tracker, before,
            "second deposit request should not mutate state"
        );
        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_cancel_deposit(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let owner_idx = random_user();
        let Some(request) = self.vault_tracker.users[owner_idx].deposit_request else {
            return;
        };

        if request.status != RequestStatus::Pending {
            return;
        }

        self.vault_tracker.users[owner_idx].deposit_request = None;
        self.vault_tracker.pending_deposit_assets = self
            .vault_tracker
            .pending_deposit_assets
            .saturating_sub(request.assets_locked);
        self.vault_tracker.asset_vault_balance = self
            .vault_tracker
            .asset_vault_balance
            .saturating_sub(request.assets_locked);
        self.vault_tracker.cumulative_cancelled_assets = self
            .vault_tracker
            .cumulative_cancelled_assets
            .saturating_add(request.assets_locked as u128);

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_fulfill_deposit_vault_priced(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let owner_idx = random_user();
        let Some(mut request) = self.vault_tracker.users[owner_idx].deposit_request else {
            return;
        };

        if request.status != RequestStatus::Pending {
            return;
        }
        if self.vault_tracker.clock.saturating_sub(request.requested_at)
            > self.vault_tracker.request_expiry_secs
        {
            return;
        }

        let shares = match convert_to_shares(
            request.assets_locked,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(value) => value,
            Err(_) => return,
        };

        request.shares_claimable = shares;
        request.status = RequestStatus::Fulfilled;
        request.fulfilled_at = self.vault_tracker.clock;
        self.vault_tracker.users[owner_idx].deposit_request = Some(request);
        self.vault_tracker.pending_deposit_assets = self
            .vault_tracker
            .pending_deposit_assets
            .saturating_sub(request.assets_locked);
        self.vault_tracker.pending_claim_shares = self
            .vault_tracker
            .pending_claim_shares
            .saturating_add(shares);
        self.vault_tracker.total_assets = self
            .vault_tracker
            .total_assets
            .saturating_add(request.assets_locked);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_add(shares);

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_fulfill_deposit_oracle_priced(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let owner_idx = random_user();
        let Some(mut request) = self.vault_tracker.users[owner_idx].deposit_request else {
            return;
        };

        if request.status != RequestStatus::Pending {
            return;
        }
        if self.vault_tracker.clock.saturating_sub(request.requested_at)
            > self.vault_tracker.request_expiry_secs
        {
            return;
        }

        let price = self.vault_tracker.expected_vault_price();
        let updated_at = self.vault_tracker.clock.saturating_sub(1);
        if validate_oracle(
            price,
            updated_at,
            self.vault_tracker.clock,
            self.vault_tracker.max_staleness,
        )
        .is_err()
        {
            return;
        }

        let shares = match oracle_assets_to_shares(request.assets_locked, price) {
            Ok(value) => value,
            Err(_) => return,
        };

        request.shares_claimable = shares;
        request.status = RequestStatus::Fulfilled;
        request.fulfilled_at = self.vault_tracker.clock;
        self.vault_tracker.users[owner_idx].deposit_request = Some(request);
        self.vault_tracker.pending_deposit_assets = self
            .vault_tracker
            .pending_deposit_assets
            .saturating_sub(request.assets_locked);
        self.vault_tracker.pending_claim_shares = self
            .vault_tracker
            .pending_claim_shares
            .saturating_add(shares);
        self.vault_tracker.total_assets = self
            .vault_tracker
            .total_assets
            .saturating_add(request.assets_locked);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_add(shares);

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_fulfill_deposit_stale_oracle_attack(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let owner_idx = random_user();
        let Some(request) = self.vault_tracker.users[owner_idx].deposit_request else {
            return;
        };

        if request.status != RequestStatus::Pending {
            return;
        }

        let before = self.vault_tracker.clone();
        let price = self.vault_tracker.expected_vault_price();
        let updated_at = self
            .vault_tracker
            .clock
            .saturating_sub(self.vault_tracker.max_staleness)
            .saturating_sub(1);

        assert!(
            validate_oracle(
                price,
                updated_at,
                self.vault_tracker.clock,
                self.vault_tracker.max_staleness,
            )
            .is_err(),
            "stale oracle should be rejected"
        );
        assert_eq!(
            self.vault_tracker, before,
            "stale oracle fulfillment must not mutate state"
        );
        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_claim_deposit(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let owner_idx = random_user();
        let Some(request) = self.vault_tracker.users[owner_idx].deposit_request else {
            return;
        };

        if request.status != RequestStatus::Fulfilled {
            return;
        }

        let claimant_idx = random_claimant(
            owner_idx,
            request.receiver,
            self.vault_tracker.operator_idx,
        );
        let authorized = self.vault_tracker.claim_authorized(
            owner_idx,
            request.receiver,
            claimant_idx,
        );

        if !authorized {
            let before = self.vault_tracker.clone();
            assert_eq!(
                self.vault_tracker, before,
                "unauthorized deposit claim must not mutate state"
            );
            self.vault_tracker.assert_invariants();
            return;
        }

        self.vault_tracker.pending_claim_shares = self
            .vault_tracker
            .pending_claim_shares
            .saturating_sub(request.shares_claimable);
        self.vault_tracker.users[request.receiver].liquid_shares = self.vault_tracker.users
            [request.receiver]
            .liquid_shares
            .saturating_add(request.shares_claimable);
        self.vault_tracker.users[owner_idx].deposit_request = None;

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_request_redeem(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let owner_idx = random_user();
        if self.vault_tracker.users[owner_idx].redeem_request.is_some() {
            return;
        }

        let liquid_shares = self.vault_tracker.users[owner_idx].liquid_shares;
        if liquid_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % liquid_shares).max(1);
        let receiver_idx = random_receiver();

        self.vault_tracker.users[owner_idx].liquid_shares = self.vault_tracker.users[owner_idx]
            .liquid_shares
            .saturating_sub(shares);
        self.vault_tracker.share_escrow_balance = self
            .vault_tracker
            .share_escrow_balance
            .saturating_add(shares);
        self.vault_tracker.users[owner_idx].redeem_request = Some(RedeemRequestState {
            receiver: receiver_idx,
            shares_locked: shares,
            assets_claimable: 0,
            status: RequestStatus::Pending,
            requested_at: self.vault_tracker.clock,
            fulfilled_at: 0,
        });

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_cancel_redeem(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let owner_idx = random_user();
        let Some(request) = self.vault_tracker.users[owner_idx].redeem_request else {
            return;
        };

        if request.status != RequestStatus::Pending {
            return;
        }

        self.vault_tracker.share_escrow_balance = self
            .vault_tracker
            .share_escrow_balance
            .saturating_sub(request.shares_locked);
        self.vault_tracker.users[owner_idx].liquid_shares = self.vault_tracker.users[owner_idx]
            .liquid_shares
            .saturating_add(request.shares_locked);
        self.vault_tracker.users[owner_idx].redeem_request = None;

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_fulfill_redeem_vault_priced(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let owner_idx = random_user();
        let Some(mut request) = self.vault_tracker.users[owner_idx].redeem_request else {
            return;
        };

        if request.status != RequestStatus::Pending {
            return;
        }
        if self.vault_tracker.clock.saturating_sub(request.requested_at)
            > self.vault_tracker.request_expiry_secs
        {
            return;
        }

        let assets = match convert_to_assets(
            request.shares_locked,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(value) => value,
            Err(_) => return,
        };

        if assets > self.vault_tracker.total_assets {
            return;
        }

        request.assets_claimable = assets;
        request.status = RequestStatus::Fulfilled;
        request.fulfilled_at = self.vault_tracker.clock;
        self.vault_tracker.users[owner_idx].redeem_request = Some(request);
        self.vault_tracker.share_escrow_balance = self
            .vault_tracker
            .share_escrow_balance
            .saturating_sub(request.shares_locked);
        self.vault_tracker.asset_vault_balance = self
            .vault_tracker
            .asset_vault_balance
            .saturating_sub(assets);
        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_sub(assets);
        self.vault_tracker.total_shares = self
            .vault_tracker
            .total_shares
            .saturating_sub(request.shares_locked);

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_fulfill_redeem_oracle_priced(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let owner_idx = random_user();
        let Some(mut request) = self.vault_tracker.users[owner_idx].redeem_request else {
            return;
        };

        if request.status != RequestStatus::Pending {
            return;
        }
        if self.vault_tracker.clock.saturating_sub(request.requested_at)
            > self.vault_tracker.request_expiry_secs
        {
            return;
        }

        let price = self.vault_tracker.expected_vault_price();
        let updated_at = self.vault_tracker.clock.saturating_sub(1);
        if validate_oracle(
            price,
            updated_at,
            self.vault_tracker.clock,
            self.vault_tracker.max_staleness,
        )
        .is_err()
        {
            return;
        }

        let assets = match oracle_shares_to_assets(request.shares_locked, price) {
            Ok(value) => value,
            Err(_) => return,
        };

        if assets > self.vault_tracker.total_assets {
            return;
        }

        request.assets_claimable = assets;
        request.status = RequestStatus::Fulfilled;
        request.fulfilled_at = self.vault_tracker.clock;
        self.vault_tracker.users[owner_idx].redeem_request = Some(request);
        self.vault_tracker.share_escrow_balance = self
            .vault_tracker
            .share_escrow_balance
            .saturating_sub(request.shares_locked);
        self.vault_tracker.asset_vault_balance = self
            .vault_tracker
            .asset_vault_balance
            .saturating_sub(assets);
        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_sub(assets);
        self.vault_tracker.total_shares = self
            .vault_tracker
            .total_shares
            .saturating_sub(request.shares_locked);

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_fulfill_redeem_pending_deposit_funding_attack(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        if self.vault_tracker.pending_deposit_assets == 0 {
            return;
        }

        let owner_idx = random_user();
        let Some(request) = self.vault_tracker.users[owner_idx].redeem_request else {
            return;
        };

        if request.status != RequestStatus::Pending || request.shares_locked == 0 {
            return;
        }

        let attack_assets = self
            .vault_tracker
            .total_assets
            .saturating_add(self.vault_tracker.pending_deposit_assets);
        if attack_assets <= self.vault_tracker.total_assets {
            return;
        }

        let attack_price = (attack_assets as u128)
            .checked_mul(PRICE_SCALE as u128)
            .and_then(|value| value.checked_div(request.shares_locked as u128))
            .unwrap_or(PRICE_SCALE as u128);
        if attack_price == 0 || attack_price > u64::MAX as u128 {
            return;
        }

        let assets = match oracle_shares_to_assets(request.shares_locked, attack_price as u64) {
            Ok(value) => value,
            Err(_) => return,
        };
        if assets <= self.vault_tracker.total_assets || assets > self.vault_tracker.asset_vault_balance {
            return;
        }

        let before = self.vault_tracker.clone();
        assert_eq!(
            self.vault_tracker, before,
            "pending deposit assets must not fund redemptions"
        );
        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_claim_redeem(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        let owner_idx = random_user();
        let Some(request) = self.vault_tracker.users[owner_idx].redeem_request else {
            return;
        };

        if request.status != RequestStatus::Fulfilled {
            return;
        }

        let claimant_idx = random_claimant(
            owner_idx,
            request.receiver,
            self.vault_tracker.operator_idx,
        );
        let authorized = self.vault_tracker.claim_authorized(
            owner_idx,
            request.receiver,
            claimant_idx,
        );

        if !authorized {
            let before = self.vault_tracker.clone();
            assert_eq!(
                self.vault_tracker, before,
                "unauthorized redeem claim must not mutate state"
            );
            self.vault_tracker.assert_invariants();
            return;
        }

        self.vault_tracker.users[request.receiver].cumulative_redeemed_assets = self.vault_tracker
            .users[request.receiver]
            .cumulative_redeemed_assets
            .saturating_add(request.assets_claimable as u128);
        self.vault_tracker.cumulative_claimed_redeem_assets = self
            .vault_tracker
            .cumulative_claimed_redeem_assets
            .saturating_add(request.assets_claimable as u128);
        self.vault_tracker.users[owner_idx].redeem_request = None;

        self.vault_tracker.assert_invariants();
    }

    #[flow]
    fn flow_expired_request_cannot_be_fulfilled(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.paused {
            return;
        }

        let owner_idx = random_user();
        let Some(request) = self.vault_tracker.users[owner_idx].deposit_request else {
            return;
        };

        if request.status != RequestStatus::Pending {
            return;
        }

        let before = self.vault_tracker.clone();
        self.vault_tracker.clock = request
            .requested_at
            .saturating_add(self.vault_tracker.request_expiry_secs)
            .saturating_add(1);
        assert_eq!(
            before.pending_deposit_assets, self.vault_tracker.pending_deposit_assets,
            "expiring a request must not mutate accounting"
        );
        self.vault_tracker.assert_invariants();
    }

    #[end]
    fn end(&mut self) {
        self.vault_tracker.assert_invariants();
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}
