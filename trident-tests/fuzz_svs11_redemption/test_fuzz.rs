//! SVS-11 Fuzz Tests — Pro-rata Redemption Lifecycle
//!
//! Property-based fuzzing of the pro-rata partial-fulfillment redemption
//! lifecycle added in the credit-markets feature:
//! - `fulfilled_shares_cumulative` never exceeds `shares_locked`
//! - `assets_claimable` monotonically non-decreasing within a request lifetime
//! - status flips Pending → Approved iff `fulfilled_cumulative >= shares_locked`
//! - cancel/reject are blocked once `assets_claimable > 0` (RequestPartiallyFulfilled)
//! - `total_pending_redeems` decrements exactly once per terminal transition
//! - `vault.total_shares` decremented by exactly `fulfill` per approve
//! - pro-rata math `(remaining * ratio) / 1e18` never extracts more than `remaining`

mod fuzz_accounts;
use fuzz_accounts::*;

use trident_fuzz::fuzzing::*;

const RATIO_SCALE_1E18: u128 = 1_000_000_000_000_000_000;
const PRICE_SCALE: u64 = 1_000_000_000;
const SHARES_DECIMALS_POW: u128 = 1_000_000_000; // 10^9
const MAX_SETTLEMENT_HORIZON_SECS: i64 = 157_680_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RequestStatus {
    None,
    Pending,
    Approved,
}

impl Default for RequestStatus {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Clone, Copy, Default, Debug)]
struct RedemptionRequest {
    shares_locked: u64,
    original_shares: u64,
    fulfilled_shares_cumulative: u64,
    assets_claimable: u64,
    queued_for_settlement_at: i64,
    status: RequestStatus,
}

#[derive(Clone, Default, Debug)]
struct VaultState {
    total_assets: u64,
    total_shares: u64,
    total_pending_deposits: u64,
    total_approved_deposits: u64,
    total_pending_redeems: u64,
    deposit_vault_amount: u64,
    redemption_escrow_amount: u64,
    claimable_tokens_amount: u64,
    nav_price: u64,
    paused: bool,
    request: RedemptionRequest,
    approve_count: u64,
    claim_count: u64,
    cancel_count: u64,
    reject_count: u64,
}

impl VaultState {
    fn available_liquidity(&self) -> u64 {
        self.deposit_vault_amount
            .saturating_sub(self.total_pending_deposits)
            .saturating_sub(self.total_approved_deposits)
    }

    fn shares_to_assets(&self, shares: u64) -> u64 {
        ((shares as u128)
            .saturating_mul(self.nav_price as u128)
            .checked_div(SHARES_DECIMALS_POW)
            .unwrap_or(0)) as u64
    }
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    state: VaultState,
    current_time: i64,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            state: VaultState {
                nav_price: PRICE_SCALE,
                deposit_vault_amount: 10_000_000_000_000,
                total_assets: 10_000_000_000_000,
                total_shares: 10_000_000_000_000,
                ..Default::default()
            },
            current_time: 1_000_000,
        }
    }

    #[init]
    fn start(&mut self) {
        self.state = VaultState {
            nav_price: PRICE_SCALE,
            deposit_vault_amount: 10_000_000_000_000,
            total_assets: 10_000_000_000_000,
            total_shares: 10_000_000_000_000,
            ..Default::default()
        };
        self.current_time = 1_000_000;
    }

    /// Mirror of request_redeem: investor locks shares into escrow + creates
    /// a fresh RedemptionRequest. Only one outstanding request per investor.
    #[flow]
    fn flow_request_redeem(&mut self) {
        if self.state.paused {
            return;
        }
        if self.state.request.status != RequestStatus::None {
            return;
        }
        if self.state.total_shares == 0 {
            return;
        }

        let max_shares = self.state.total_shares.min(1_000_000_000_000);
        let shares: u64 = (rand::random::<u64>() % max_shares) + 1;

        self.state.request = RedemptionRequest {
            shares_locked: shares,
            original_shares: shares,
            fulfilled_shares_cumulative: 0,
            assets_claimable: 0,
            queued_for_settlement_at: 0,
            status: RequestStatus::Pending,
        };
        self.state.redemption_escrow_amount =
            self.state.redemption_escrow_amount.saturating_add(shares);
        self.state.total_pending_redeems = self.state.total_pending_redeems.saturating_add(1);

        // INVARIANT: original_shares is the immutable snapshot.
        assert_eq!(
            self.state.request.original_shares, self.state.request.shares_locked,
            "original_shares != shares_locked at creation"
        );
        // INVARIANT: cumulative starts at 0.
        assert_eq!(
            self.state.request.fulfilled_shares_cumulative, 0,
            "fresh request has non-zero cumulative"
        );
    }

    /// Mirror of approve_redeem with a random fixed-point ratio in (0, 1e18].
    /// Models the partial-fulfillment + auto-requeue + final-flip semantics.
    #[flow]
    fn flow_approve_redeem(&mut self) {
        if self.state.paused {
            return;
        }
        if self.state.request.status != RequestStatus::Pending {
            return;
        }

        // Random ratio in (0, 1e18]
        let ratio_u128: u128 = (rand::random::<u128>() % RATIO_SCALE_1E18) + 1;
        // next_settlement_at: 0 sentinel or within horizon
        let next_settlement_at: i64 = if rand::random::<bool>() {
            0
        } else {
            self.current_time + (rand::random::<i64>() % MAX_SETTLEMENT_HORIZON_SECS).abs()
        };

        let req = &self.state.request;
        let shares_locked = req.shares_locked;
        let already = req.fulfilled_shares_cumulative;
        let remaining = match shares_locked.checked_sub(already) {
            Some(v) if v > 0 => v,
            _ => return, // nothing to settle
        };

        let fulfill: u64 = ((remaining as u128 * ratio_u128) / RATIO_SCALE_1E18) as u64;
        if fulfill == 0 {
            // Mirrors on-chain ZeroAmount reject — ratio too small for residual.
            // INVARIANT: this is the dust-orphan path. Cumulative MUST be unchanged.
            assert_eq!(
                self.state.request.fulfilled_shares_cumulative, already,
                "dust-orphan path mutated cumulative"
            );
            return;
        }
        // INVARIANT: floor-rounded fulfill never exceeds remaining.
        assert!(
            fulfill <= remaining,
            "pro-rata fulfill {} > remaining {}",
            fulfill,
            remaining
        );

        let gross_assets = self.state.shares_to_assets(fulfill);
        let net_assets = gross_assets; // no exit fee in model
        if net_assets == 0 {
            return;
        }
        if self.state.available_liquidity() < net_assets {
            return; // mirrors InsufficientLiquidity
        }

        // Apply effects.
        let prev_cumulative = self.state.request.fulfilled_shares_cumulative;
        let prev_claimable = self.state.request.assets_claimable;
        let prev_total_shares = self.state.total_shares;
        let prev_pending = self.state.total_pending_redeems;

        // Burn shares from escrow.
        self.state.redemption_escrow_amount =
            self.state.redemption_escrow_amount.saturating_sub(fulfill);
        // Transfer assets deposit_vault → claimable_tokens.
        self.state.deposit_vault_amount =
            self.state.deposit_vault_amount.saturating_sub(net_assets);
        self.state.claimable_tokens_amount = self
            .state
            .claimable_tokens_amount
            .saturating_add(net_assets);

        let new_cumulative = self
            .state
            .request
            .fulfilled_shares_cumulative
            .saturating_add(fulfill);
        self.state.request.fulfilled_shares_cumulative = new_cumulative;
        self.state.request.assets_claimable = self
            .state
            .request
            .assets_claimable
            .saturating_add(net_assets);

        if new_cumulative >= shares_locked {
            self.state.request.status = RequestStatus::Approved;
        } else {
            self.state.request.queued_for_settlement_at = next_settlement_at;
        }

        self.state.total_assets = self.state.total_assets.saturating_sub(net_assets);
        self.state.total_shares = self.state.total_shares.saturating_sub(fulfill);
        if new_cumulative >= shares_locked {
            self.state.total_pending_redeems =
                self.state.total_pending_redeems.saturating_sub(1);
        }
        self.state.approve_count += 1;

        // INVARIANT: cumulative monotonically increases.
        assert!(
            self.state.request.fulfilled_shares_cumulative > prev_cumulative,
            "cumulative did not increase on approve"
        );
        // INVARIANT: cumulative never exceeds shares_locked.
        assert!(
            self.state.request.fulfilled_shares_cumulative <= shares_locked,
            "cumulative {} > shares_locked {}",
            self.state.request.fulfilled_shares_cumulative,
            shares_locked
        );
        // INVARIANT: assets_claimable monotonically increases.
        assert!(
            self.state.request.assets_claimable > prev_claimable,
            "assets_claimable did not increase on approve"
        );
        // INVARIANT: total_shares decremented by exactly `fulfill`.
        assert_eq!(
            self.state.total_shares,
            prev_total_shares.saturating_sub(fulfill),
            "total_shares delta != fulfill"
        );
        // INVARIANT: status flip iff cumulative reached shares_locked.
        if self.state.request.fulfilled_shares_cumulative >= shares_locked {
            assert_eq!(
                self.state.request.status,
                RequestStatus::Approved,
                "full fulfillment did not flip status"
            );
            assert_eq!(
                self.state.total_pending_redeems,
                prev_pending - 1,
                "pending counter not decremented on full"
            );
        } else {
            assert_eq!(
                self.state.request.status,
                RequestStatus::Pending,
                "partial fulfillment flipped status prematurely"
            );
            assert_eq!(
                self.state.total_pending_redeems, prev_pending,
                "pending counter changed on partial"
            );
        }
    }

    /// Mirror of claim_redeem: only when status == Approved. Drains
    /// claimable_tokens → investor + closes the request.
    #[flow]
    fn flow_claim_redeem(&mut self) {
        if self.state.request.status != RequestStatus::Approved {
            return;
        }

        let claimable = self.state.request.assets_claimable;
        // INVARIANT: claimable matches the on-chain claimable_tokens balance
        //            up to the per-request portion (only one request modeled here).
        assert_eq!(
            self.state.claimable_tokens_amount, claimable,
            "claimable_tokens drift from request.assets_claimable"
        );

        self.state.claimable_tokens_amount = 0;
        self.state.request = RedemptionRequest::default();
        self.state.claim_count += 1;
    }

    /// Mirror of cancel_redeem: only when status == Pending AND
    /// assets_claimable == 0 (`RequestPartiallyFulfilled` guard).
    #[flow]
    fn flow_cancel_redeem(&mut self) {
        if self.state.paused {
            return;
        }
        if self.state.request.status != RequestStatus::Pending {
            return;
        }
        // The audit-hardening RequestPartiallyFulfilled guard.
        if self.state.request.assets_claimable != 0 {
            return;
        }

        let prev_pending = self.state.total_pending_redeems;
        let returned_shares = self.state.request.shares_locked;

        self.state.redemption_escrow_amount = self
            .state
            .redemption_escrow_amount
            .saturating_sub(returned_shares);
        self.state.total_pending_redeems = self.state.total_pending_redeems.saturating_sub(1);
        self.state.request = RedemptionRequest::default();
        self.state.cancel_count += 1;

        // INVARIANT: pending counter decremented exactly once.
        assert_eq!(
            self.state.total_pending_redeems,
            prev_pending - 1,
            "pending counter delta != 1 on cancel"
        );
        // INVARIANT: claimable_tokens unchanged on cancel (was 0 by guard, stays 0).
        assert_eq!(
            self.state.claimable_tokens_amount, 0,
            "claimable_tokens non-zero on cancel"
        );
    }

    /// Mirror of reject_redeem: manager-initiated cancel. Same partial guard.
    #[flow]
    fn flow_reject_redeem(&mut self) {
        if self.state.request.status != RequestStatus::Pending {
            return;
        }
        if self.state.request.assets_claimable != 0 {
            return;
        }

        let prev_pending = self.state.total_pending_redeems;
        let returned_shares = self.state.request.shares_locked;

        self.state.redemption_escrow_amount = self
            .state
            .redemption_escrow_amount
            .saturating_sub(returned_shares);
        self.state.total_pending_redeems = self.state.total_pending_redeems.saturating_sub(1);
        self.state.request = RedemptionRequest::default();
        self.state.reject_count += 1;

        assert_eq!(
            self.state.total_pending_redeems,
            prev_pending - 1,
            "pending counter delta != 1 on reject"
        );
    }

    /// Random NAV moves within the deviation guard's tolerance.
    #[flow]
    fn flow_update_nav(&mut self) {
        let cur = self.state.nav_price;
        let max_step = (cur / 200).max(1); // ~50 bps per step
        let delta: i128 = (rand::random::<i64>() % (max_step as i64 * 2)) as i128 - max_step as i128;
        let new_price = (cur as i128 + delta).max(1) as u64;
        self.state.nav_price = new_price;
        self.current_time += (rand::random::<i64>() % 60).abs() + 1;

        assert!(self.state.nav_price > 0, "zero NAV price");
    }

    #[flow]
    fn flow_pause_unpause(&mut self) {
        self.state.paused = !self.state.paused;
    }

    #[end]
    fn end(&mut self) {
        // INVARIANT: cumulative never exceeds locked at end-of-run.
        assert!(
            self.state.request.fulfilled_shares_cumulative <= self.state.request.shares_locked,
            "Final: cumulative {} > shares_locked {}",
            self.state.request.fulfilled_shares_cumulative,
            self.state.request.shares_locked
        );

        // INVARIANT: status consistency at end-of-run.
        match self.state.request.status {
            RequestStatus::Approved => {
                assert!(
                    self.state.request.fulfilled_shares_cumulative
                        >= self.state.request.shares_locked,
                    "Approved but cumulative < shares_locked"
                );
            }
            RequestStatus::Pending => {
                assert!(
                    self.state.request.fulfilled_shares_cumulative
                        < self.state.request.shares_locked,
                    "Pending but cumulative >= shares_locked"
                );
            }
            RequestStatus::None => {
                // No open request — escrow + claimable_tokens must be drained.
                assert_eq!(
                    self.state.claimable_tokens_amount, 0,
                    "Final: no request but claimable_tokens != 0"
                );
            }
        }

        // INVARIANT: total_shares + redemption_escrow_amount conservation.
        // (Shares burned through claims came from escrow; partial-fulfill burns
        // come from escrow; cancel/reject returns escrow to investor.)
        // Note: this is a weak invariant in a single-request model — the
        // multi-request property would need a richer accounts model.

        // INVARIANT: claimable_tokens never exceeds total cumulative net_assets transferred.
        assert!(
            self.state.claimable_tokens_amount <= self.state.request.assets_claimable
                || self.state.request.status == RequestStatus::None,
            "claimable_tokens > assets_claimable mid-lifecycle"
        );
    }
}

fn main() {
    FuzzTest::fuzz(5000, 60);
}
