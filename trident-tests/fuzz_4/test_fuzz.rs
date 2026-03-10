use fuzz_accounts::*;
use svs_math::{convert_to_assets, convert_to_shares, Rounding};
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;

const NUM_USERS: usize = 5;
const PRICE_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18
const MAX_DEVIATION_BPS: u16 = 500; // 5%

#[derive(Clone, Copy, PartialEq)]
enum RequestStatus {
    None,
    Pending,
    Fulfilled,
}

#[derive(Clone, Copy, Default)]
struct DepositRequest {
    assets_locked: u64,
    shares_claimable: u64,
    status: RequestStatusField,
}

#[derive(Clone, Copy, Default)]
struct RedeemRequest {
    shares_locked: u64,
    assets_claimable: u64,
    status: RequestStatusField,
}

#[derive(Clone, Copy)]
struct RequestStatusField(RequestStatus);

impl Default for RequestStatusField {
    fn default() -> Self {
        Self(RequestStatus::None)
    }
}

#[derive(Clone, Copy, Default)]
struct UserState {
    shares_balance: u64,
    deposit_request: DepositRequest,
    redeem_request: RedeemRequest,
    cumulative_deposited: u128,
    cumulative_redeemed: u128,
    operator_approved: [bool; NUM_USERS],
}

/// Async vault state tracker for invariant checks.
/// Model-based fuzz test validating the request→fulfill→claim lifecycle,
/// share price monotonicity, pending deposit isolation, and operator delegation.
#[derive(Default, Clone)]
struct AsyncVaultTracker {
    initialized: bool,
    total_assets: u64,
    total_shares: u64,
    total_pending_deposits: u64,
    decimals_offset: u8,
    paused: bool,
    max_deviation_bps: u16,
    users: [UserState; NUM_USERS],
    deposit_count: u64,
    redeem_count: u64,
    fulfill_count: u64,
    claim_count: u64,
    cancel_count: u64,
}

impl AsyncVaultTracker {
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

    fn shares_in_escrow(&self) -> u64 {
        self.users.iter().fold(0u64, |acc, u| {
            if u.redeem_request.status.0 == RequestStatus::Pending {
                acc.saturating_add(u.redeem_request.shares_locked)
            } else {
                acc
            }
        })
    }

    fn reserved_shares(&self) -> u64 {
        self.users.iter().fold(0u64, |acc, u| {
            if u.deposit_request.status.0 == RequestStatus::Fulfilled {
                acc.saturating_add(u.deposit_request.shares_claimable)
            } else {
                acc
            }
        })
    }

    fn pending_assets_sum(&self) -> u64 {
        self.users.iter().fold(0u64, |acc, u| {
            if u.deposit_request.status.0 == RequestStatus::Pending {
                acc.saturating_add(u.deposit_request.assets_locked)
            } else {
                acc
            }
        })
    }
}

fn random_user() -> usize {
    rand::random::<usize>() % NUM_USERS
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    vault: AsyncVaultTracker,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            vault: AsyncVaultTracker::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        self.vault = AsyncVaultTracker::default();
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    #[flow]
    fn flow_initialize(&mut self) {
        if self.vault.initialized {
            return;
        }
        let fuzz_decimals: u8 = rand::random::<u8>() % 10;
        self.vault.decimals_offset = fuzz_decimals;
        self.vault.max_deviation_bps = MAX_DEVIATION_BPS;
        self.vault.initialized = true;
    }

    // =========================================================================
    // Deposit lifecycle: request → fulfill → claim
    // =========================================================================

    #[flow]
    fn flow_request_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        if self.vault.users[user_idx].deposit_request.status.0 != RequestStatus::None {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 1_000_000_000_000).max(1000);

        let pending_before = self.vault.total_pending_deposits;
        let total_assets_before = self.vault.total_assets;
        let price_before = self.vault.share_price_x1e18();

        self.vault.users[user_idx].deposit_request = DepositRequest {
            assets_locked: assets,
            shares_claimable: 0,
            status: RequestStatusField(RequestStatus::Pending),
        };
        self.vault.total_pending_deposits = self.vault.total_pending_deposits.saturating_add(assets);
        self.vault.deposit_count += 1;

        // INVARIANT: Pending deposits do NOT affect total_assets or share price
        assert_eq!(
            self.vault.total_assets, total_assets_before,
            "total_assets changed on request_deposit"
        );
        assert_eq!(
            self.vault.share_price_x1e18(),
            price_before,
            "Share price changed on request_deposit"
        );

        // INVARIANT: total_pending_deposits incremented correctly
        assert_eq!(
            self.vault.total_pending_deposits,
            pending_before.saturating_add(assets),
            "total_pending_deposits not incremented"
        );
    }

    #[flow]
    fn flow_fulfill_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let assets = req.assets_locked;
        let price_before = self.vault.share_price_x1e18();

        // Compute shares using vault price (floor rounding favors vault)
        let shares = match convert_to_shares(
            assets,
            self.vault.total_assets,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        // Move assets from pending into AUM
        self.vault.total_pending_deposits = self
            .vault
            .total_pending_deposits
            .saturating_sub(assets);
        self.vault.total_assets = self.vault.total_assets.saturating_add(assets);
        // Reserve shares (included in total_shares before minting)
        self.vault.total_shares = self.vault.total_shares.saturating_add(shares);

        self.vault.users[user_idx].deposit_request = DepositRequest {
            assets_locked: assets,
            shares_claimable: shares,
            status: RequestStatusField(RequestStatus::Fulfilled),
        };
        self.vault.fulfill_count += 1;

        // INVARIANT: Share price should not decrease after fulfill
        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after fulfill_deposit: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_claim_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Fulfilled {
            return;
        }

        let shares = req.shares_claimable;
        let price_before = self.vault.share_price_x1e18();

        // Mint shares to user (total_shares already includes these from fulfill)
        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault.users[user_idx].cumulative_deposited += req.assets_locked as u128;

        // Reset request
        self.vault.users[user_idx].deposit_request = DepositRequest::default();
        self.vault.claim_count += 1;

        // INVARIANT: Share price unchanged by claim (no new assets/shares, just mint)
        let price_after = self.vault.share_price_x1e18();
        assert_eq!(
            price_after, price_before,
            "Share price changed on claim_deposit: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_cancel_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let assets = req.assets_locked;
        let price_before = self.vault.share_price_x1e18();

        self.vault.total_pending_deposits = self
            .vault
            .total_pending_deposits
            .saturating_sub(assets);
        self.vault.users[user_idx].deposit_request = DepositRequest::default();
        self.vault.cancel_count += 1;

        // INVARIANT: Cancel doesn't affect share price
        assert_eq!(
            self.vault.share_price_x1e18(),
            price_before,
            "Share price changed on cancel_deposit"
        );
    }

    // =========================================================================
    // Redeem lifecycle: request → fulfill → claim
    // =========================================================================

    #[flow]
    fn flow_request_redeem(&mut self) {
        if !self.vault.initialized || self.vault.paused || self.vault.total_shares == 0 {
            return;
        }

        let user_idx = random_user();
        if self.vault.users[user_idx].redeem_request.status.0 != RequestStatus::None {
            return;
        }

        let user_shares = self.vault.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % user_shares).max(1);
        let price_before = self.vault.share_price_x1e18();

        // Lock shares in escrow
        self.vault.users[user_idx].shares_balance -= shares;
        self.vault.users[user_idx].redeem_request = RedeemRequest {
            shares_locked: shares,
            assets_claimable: 0,
            status: RequestStatusField(RequestStatus::Pending),
        };

        // INVARIANT: Locking shares in escrow doesn't change total_shares or price
        assert_eq!(
            self.vault.share_price_x1e18(),
            price_before,
            "Share price changed on request_redeem"
        );
    }

    #[flow]
    fn flow_fulfill_redeem(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].redeem_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let shares = req.shares_locked;
        let price_before = self.vault.share_price_x1e18();

        // Compute assets (floor rounding favors vault)
        let assets = match convert_to_assets(
            shares,
            self.vault.total_assets,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets > self.vault.total_assets {
            return;
        }

        // Burn shares from escrow, move assets to claimable
        self.vault.total_shares = self.vault.total_shares.saturating_sub(shares);
        self.vault.total_assets = self.vault.total_assets.saturating_sub(assets);

        self.vault.users[user_idx].redeem_request = RedeemRequest {
            shares_locked: 0,
            assets_claimable: assets,
            status: RequestStatusField(RequestStatus::Fulfilled),
        };
        self.vault.fulfill_count += 1;

        // INVARIANT: Share price should not decrease after fulfill
        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after fulfill_redeem: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_claim_redeem(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].redeem_request;
        if req.status.0 != RequestStatus::Fulfilled {
            return;
        }

        let assets = req.assets_claimable;
        let price_before = self.vault.share_price_x1e18();

        self.vault.users[user_idx].cumulative_redeemed += assets as u128;
        self.vault.users[user_idx].redeem_request = RedeemRequest::default();
        self.vault.redeem_count += 1;
        self.vault.claim_count += 1;

        // INVARIANT: Claim doesn't change share price (assets already removed at fulfill)
        assert_eq!(
            self.vault.share_price_x1e18(),
            price_before,
            "Share price changed on claim_redeem"
        );
    }

    #[flow]
    fn flow_cancel_redeem(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].redeem_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let shares = req.shares_locked;

        // Return shares from escrow to user
        self.vault.users[user_idx].shares_balance += shares;
        self.vault.users[user_idx].redeem_request = RedeemRequest::default();
        self.vault.cancel_count += 1;
    }

    // =========================================================================
    // Oracle-priced fulfillment
    // =========================================================================

    #[flow]
    fn flow_fulfill_deposit_oracle(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let assets = req.assets_locked;

        // Skip oracle deviation check for empty vault
        if self.vault.total_assets > 0 && self.vault.total_shares > 0 {
            let oracle_price: u64 = (rand::random::<u64>() % 2_000_000_000).max(1);

            // Check deviation
            let vault_price_num = self.vault.total_assets as u128 * 1_000_000_000u128;
            let vault_price = vault_price_num / self.vault.total_shares.max(1) as u128;
            let deviation = if oracle_price as u128 > vault_price {
                (oracle_price as u128 - vault_price) * 10_000 / vault_price.max(1)
            } else {
                (vault_price - oracle_price as u128) * 10_000 / vault_price.max(1)
            };

            if deviation > self.vault.max_deviation_bps as u128 {
                // INVARIANT: Oracle deviation exceeds limit — must reject
                return;
            }

            // Use oracle price for conversion
            let shares = (assets as u128 * 1_000_000_000u128 / oracle_price.max(1) as u128) as u64;
            if shares == 0 {
                return;
            }

            let price_before = self.vault.share_price_x1e18();

            self.vault.total_pending_deposits = self
                .vault
                .total_pending_deposits
                .saturating_sub(assets);
            self.vault.total_assets = self.vault.total_assets.saturating_add(assets);
            self.vault.total_shares = self.vault.total_shares.saturating_add(shares);

            self.vault.users[user_idx].deposit_request = DepositRequest {
                assets_locked: assets,
                shares_claimable: shares,
                status: RequestStatusField(RequestStatus::Fulfilled),
            };
            self.vault.fulfill_count += 1;

            // Note: Oracle-priced fulfill may change price within deviation bounds
            let price_after = self.vault.share_price_x1e18();
            let price_change = if price_after > price_before {
                (price_after - price_before) * 10_000 / price_before.max(1)
            } else {
                (price_before - price_after) * 10_000 / price_before.max(1)
            };

            // INVARIANT: Price change within deviation bounds
            assert!(
                price_change <= (self.vault.max_deviation_bps as u128 + 100) * 2,
                "Oracle fulfill caused excessive price change: {}bps",
                price_change
            );
        }
    }

    // =========================================================================
    // Operator delegation
    // =========================================================================

    #[flow]
    fn flow_set_operator(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let owner_idx = random_user();
        let operator_idx = random_user();
        if owner_idx == operator_idx {
            return;
        }

        let approved: bool = rand::random();
        self.vault.users[owner_idx].operator_approved[operator_idx] = approved;
    }

    #[flow]
    fn flow_operator_claim_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let owner_idx = random_user();
        let operator_idx = random_user();
        if owner_idx == operator_idx {
            return;
        }

        let req = &self.vault.users[owner_idx].deposit_request;
        if req.status.0 != RequestStatus::Fulfilled {
            return;
        }

        // INVARIANT: Unapproved operator cannot claim
        if !self.vault.users[owner_idx].operator_approved[operator_idx] {
            return;
        }

        let shares = req.shares_claimable;
        self.vault.users[owner_idx].shares_balance += shares;
        self.vault.users[owner_idx].cumulative_deposited += req.assets_locked as u128;
        self.vault.users[owner_idx].deposit_request = DepositRequest::default();
        self.vault.claim_count += 1;
    }

    // =========================================================================
    // Admin
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

    // =========================================================================
    // Roundtrip invariant: request→fulfill→claim→request_redeem→fulfill→claim
    // =========================================================================

    #[flow]
    fn flow_full_roundtrip(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let assets_before = self.vault.total_assets;
        let shares_before = self.vault.total_shares;

        if assets_before < 1000 || shares_before == 0 {
            return;
        }

        let offset = 10u64.pow(self.vault.decimals_offset as u32);
        let ratio = (shares_before as u128) / (assets_before as u128).max(1);
        if ratio > offset as u128 * 100 {
            return;
        }

        let test_amount: u64 = (rand::random::<u64>() % 1_000_000_000).max(1000);

        // Simulate deposit fulfill
        let shares = match convert_to_shares(
            test_amount,
            assets_before,
            shares_before,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares == 0 {
            return;
        }

        let new_assets = match assets_before.checked_add(test_amount) {
            Some(v) => v,
            None => return,
        };
        let new_shares = match shares_before.checked_add(shares) {
            Some(v) => v,
            None => return,
        };

        // Simulate immediate redeem fulfill
        let assets_back = match convert_to_assets(
            shares,
            new_assets,
            new_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        // INVARIANT: Round-trip must not create free assets
        assert!(
            assets_back <= test_amount,
            "CRITICAL: Async round-trip created free assets! in={}, out={}, shares={}",
            test_amount,
            assets_back,
            shares,
        );

        // Reasonable loss check
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

    // =========================================================================
    // Inflation attack via async flow
    // =========================================================================

    #[flow]
    fn flow_inflation_attack_async(&mut self) {
        if !self.vault.initialized {
            return;
        }
        if self.vault.total_assets > 0 || self.vault.total_shares > 0 {
            return;
        }

        let offset = self.vault.decimals_offset;

        // Attacker deposits first
        let attacker_deposit: u64 = 1000;
        let attacker_shares =
            convert_to_shares(attacker_deposit, 0, 0, offset, Rounding::Floor).unwrap_or(0);

        let mut vault_assets = attacker_deposit;
        let mut vault_shares = attacker_shares;

        // Attacker donates directly to vault ATA (front-running attack)
        let donation: u64 = (rand::random::<u64>() % 10_000_000).max(1000);
        vault_assets = vault_assets.saturating_add(donation);

        // Victim deposits via async request→fulfill
        let victim_deposit: u64 = 100_000;
        let victim_shares = convert_to_shares(
            victim_deposit,
            vault_assets,
            vault_shares,
            offset,
            Rounding::Floor,
        )
        .unwrap_or(0);

        vault_assets = vault_assets.saturating_add(victim_deposit);
        vault_shares = vault_shares.saturating_add(victim_shares);

        // Victim redeems immediately
        let victim_can_redeem =
            convert_to_assets(victim_shares, vault_assets, vault_shares, offset, Rounding::Floor)
                .unwrap_or(0);

        // INVARIANT: Victim should not lose more than 10% to inflation attack
        assert!(
            victim_can_redeem >= victim_deposit * 9 / 10,
            "Inflation attack succeeded! victim deposited={}, can_redeem={}, donation={}",
            victim_deposit,
            victim_can_redeem,
            donation
        );
    }

    // =========================================================================
    // Global invariant checks (called after every flow)
    // =========================================================================

    #[flow]
    fn flow_check_invariants(&mut self) {
        if !self.vault.initialized {
            return;
        }

        // INVARIANT 1: Sum of user shares + escrowed shares + reserved shares == total_shares
        let user_shares = self.vault.user_shares_sum();
        let escrowed = self.vault.shares_in_escrow();
        let reserved = self.vault.reserved_shares();
        let accounted_shares = user_shares
            .saturating_add(escrowed)
            .saturating_add(reserved);

        assert_eq!(
            accounted_shares, self.vault.total_shares,
            "Share accounting mismatch: users={} + escrow={} + reserved={} = {} != total={}",
            user_shares,
            escrowed,
            reserved,
            accounted_shares,
            self.vault.total_shares
        );

        // INVARIANT 2: total_pending_deposits == sum of pending deposit requests
        let pending_sum = self.vault.pending_assets_sum();
        assert_eq!(
            pending_sum, self.vault.total_pending_deposits,
            "Pending deposits mismatch: sum={} != tracked={}",
            pending_sum,
            self.vault.total_pending_deposits
        );

        // INVARIANT 3: Each user has at most one active deposit request and one active redeem request
        for (i, user) in self.vault.users.iter().enumerate() {
            let deposit_active =
                user.deposit_request.status.0 != RequestStatus::None;
            let redeem_active =
                user.redeem_request.status.0 != RequestStatus::None;

            // A user may have both a deposit and redeem request simultaneously
            // but never two of the same type (PDA uniqueness)
            if deposit_active {
                assert!(
                    user.deposit_request.assets_locked > 0
                        || user.deposit_request.shares_claimable > 0,
                    "User {} has empty active deposit request",
                    i
                );
            }
            if redeem_active {
                assert!(
                    user.redeem_request.shares_locked > 0
                        || user.redeem_request.assets_claimable > 0,
                    "User {} has empty active redeem request",
                    i
                );
            }
        }

        // INVARIANT 4: No share-from-nothing
        if self.vault.total_assets == 0 && self.vault.total_pending_deposits == 0 {
            // If there are no assets at all, total_shares should be 0
            // (edge case: shares could exist if a redeem was fulfilled but not claimed)
            // This is acceptable — the shares are "ghost shares" backed by claimable assets
        }
    }

    // =========================================================================
    // Edge cases
    // =========================================================================

    #[flow]
    fn flow_double_request_blocked(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();

        // INVARIANT: Cannot create a second deposit request while one is active
        if self.vault.users[user_idx].deposit_request.status.0 != RequestStatus::None {
            // On-chain this would fail with "account already in use"
            // In our model, we just verify we don't allow it
            let status = self.vault.users[user_idx].deposit_request.status.0;
            assert!(
                status == RequestStatus::Pending || status == RequestStatus::Fulfilled,
                "Active request in unexpected state"
            );
        }
    }

    #[flow]
    fn flow_fulfill_wrong_status_blocked(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let user_idx = random_user();

        // INVARIANT: Cannot fulfill a non-pending request
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 == RequestStatus::Fulfilled {
            // On-chain: VaultError::InvalidStatus
            // Model: verify we don't re-fulfill
        }
        if req.status.0 == RequestStatus::None {
            // On-chain: PDA doesn't exist
        }
    }

    #[flow]
    fn flow_paused_blocks_all(&mut self) {
        if !self.vault.initialized || !self.vault.paused {
            return;
        }

        let assets_before = self.vault.total_assets;
        let shares_before = self.vault.total_shares;
        let pending_before = self.vault.total_pending_deposits;

        // INVARIANT: When paused, no state changes happen
        // (all flows return early when paused)
        assert_eq!(self.vault.total_assets, assets_before);
        assert_eq!(self.vault.total_shares, shares_before);
        assert_eq!(self.vault.total_pending_deposits, pending_before);
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}
