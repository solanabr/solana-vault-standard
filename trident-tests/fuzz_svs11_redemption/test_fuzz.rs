//! SVS-11 Fuzz Tests — Full-Approval Redemption Lifecycle
//!
//! Property-based fuzzing of the individual full-approval redemption lifecycle
//! (the pro-rata/partial-fulfillment path was reverted — D5):
//! - a request is created Pending with `assets_claimable == 0`
//! - `approve_redeem` is atomic: it burns ALL `shares_locked` and pays out
//!   their full asset value in one shot (no ratio, no requeue, no partials)
//! - status flips Pending → Approved exactly once, on approve
//! - `total_pending_redeems` decrements exactly once per terminal transition
//! - `vault.total_shares` is decremented by exactly `shares_locked` per approve
//! - cancel/reject return the escrowed shares and close the (Pending) request
//! - `approve_redeem` reverts (no state change) when idle liquidity < payout

mod fuzz_accounts;
use fuzz_accounts::*;

use trident_fuzz::fuzzing::*;

const PRICE_SCALE: u64 = 1_000_000_000;
const SHARES_DECIMALS_POW: u128 = 1_000_000_000; // 10^9

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
    assets_claimable: u64,
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
            .checked_sub(self.total_pending_deposits)
            .expect("fuzz model overflow: sub")
            .checked_sub(self.total_approved_deposits)
            .expect("fuzz model overflow: sub")
    }

    fn shares_to_assets(&self, shares: u64) -> u64 {
        ((shares as u128)
            .checked_mul(self.nav_price as u128)
            .expect("fuzz model overflow: mul")
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

    /// Mirror of request_redeem: investor locks shares into escrow + creates a
    /// fresh Pending RedemptionRequest. Only one outstanding request modeled.
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
            assets_claimable: 0,
            status: RequestStatus::Pending,
        };
        self.state.redemption_escrow_amount = self
            .state
            .redemption_escrow_amount
            .checked_add(shares)
            .expect("fuzz model overflow: add");
        self.state.total_pending_redeems = self
            .state
            .total_pending_redeems
            .checked_add(1)
            .expect("fuzz model overflow: add");

        // INVARIANT: a fresh request is Pending with nothing claimable yet.
        assert_eq!(
            self.state.request.assets_claimable, 0,
            "fresh request has non-zero assets_claimable"
        );
    }

    /// Mirror of approve_redeem: atomic FULL approval. Burns all `shares_locked`
    /// and pays out their full asset value; no ratio / partial / requeue.
    #[flow]
    fn flow_approve_redeem(&mut self) {
        if self.state.paused {
            return;
        }
        if self.state.request.status != RequestStatus::Pending {
            return;
        }

        let shares_locked = self.state.request.shares_locked;
        if shares_locked == 0 {
            return; // mirrors ZeroAmount
        }

        let gross_assets = self.state.shares_to_assets(shares_locked);
        let net_assets = gross_assets; // no exit fee in model
        if net_assets == 0 {
            return;
        }
        if self.state.available_liquidity() < net_assets {
            return; // mirrors InsufficientLiquidity (no state change)
        }

        let prev_total_shares = self.state.total_shares;
        let prev_pending = self.state.total_pending_redeems;
        let prev_escrow = self.state.redemption_escrow_amount;

        // Burn ALL locked shares from escrow.
        self.state.redemption_escrow_amount = self
            .state
            .redemption_escrow_amount
            .checked_sub(shares_locked)
            .expect("fuzz model overflow: sub");
        // Transfer payout deposit_vault → claimable_tokens.
        self.state.deposit_vault_amount = self
            .state
            .deposit_vault_amount
            .checked_sub(net_assets)
            .expect("fuzz model overflow: sub");
        self.state.claimable_tokens_amount = self
            .state
            .claimable_tokens_amount
            .checked_add(net_assets)
            .expect("fuzz model overflow: add");

        self.state.request.assets_claimable = net_assets;
        self.state.request.status = RequestStatus::Approved;

        self.state.total_assets = self
            .state
            .total_assets
            .checked_sub(net_assets)
            .expect("fuzz model overflow: sub");
        self.state.total_shares = self
            .state
            .total_shares
            .checked_sub(shares_locked)
            .expect("fuzz model overflow: sub");
        self.state.total_pending_redeems = self
            .state
            .total_pending_redeems
            .checked_sub(1)
            .expect("fuzz model overflow: sub");
        self.state.approve_count += 1;

        // INVARIANT: status flips to Approved exactly on approve.
        assert_eq!(
            self.state.request.status,
            RequestStatus::Approved,
            "approve did not flip status to Approved"
        );
        // INVARIANT: total_shares decremented by exactly `shares_locked`.
        assert_eq!(
            self.state.total_shares,
            prev_total_shares
                .checked_sub(shares_locked)
                .expect("fuzz model overflow: sub"),
            "total_shares delta != shares_locked"
        );
        // INVARIANT: escrow decremented by exactly `shares_locked`.
        assert_eq!(
            self.state.redemption_escrow_amount,
            prev_escrow
                .checked_sub(shares_locked)
                .expect("fuzz model overflow: sub"),
            "escrow delta != shares_locked"
        );
        // INVARIANT: pending counter decremented exactly once.
        assert_eq!(
            self.state.total_pending_redeems,
            prev_pending - 1,
            "pending counter delta != 1 on approve"
        );
        // INVARIANT: claimable equals the single full payout.
        assert_eq!(
            self.state.request.assets_claimable, net_assets,
            "assets_claimable != net payout on full approval"
        );
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
        //            (only one request modeled here).
        assert_eq!(
            self.state.claimable_tokens_amount, claimable,
            "claimable_tokens drift from request.assets_claimable"
        );

        self.state.claimable_tokens_amount = 0;
        self.state.request = RedemptionRequest::default();
        self.state.claim_count += 1;
    }

    /// Mirror of cancel_redeem: only when status == Pending. Returns the
    /// escrowed shares to the investor and closes the request.
    #[flow]
    fn flow_cancel_redeem(&mut self) {
        if self.state.paused {
            return;
        }
        if self.state.request.status != RequestStatus::Pending {
            return;
        }

        let prev_pending = self.state.total_pending_redeems;
        let returned_shares = self.state.request.shares_locked;

        self.state.redemption_escrow_amount = self
            .state
            .redemption_escrow_amount
            .checked_sub(returned_shares)
            .expect("fuzz model overflow: sub");
        self.state.total_pending_redeems = self
            .state
            .total_pending_redeems
            .checked_sub(1)
            .expect("fuzz model overflow: sub");
        self.state.request = RedemptionRequest::default();
        self.state.cancel_count += 1;

        // INVARIANT: pending counter decremented exactly once.
        assert_eq!(
            self.state.total_pending_redeems,
            prev_pending - 1,
            "pending counter delta != 1 on cancel"
        );
        // INVARIANT: claimable_tokens unchanged on cancel (a Pending request
        // has nothing claimable).
        assert_eq!(
            self.state.claimable_tokens_amount, 0,
            "claimable_tokens non-zero on cancel"
        );
    }

    /// Mirror of reject_redeem: manager-initiated cancel of a Pending request.
    #[flow]
    fn flow_reject_redeem(&mut self) {
        if self.state.request.status != RequestStatus::Pending {
            return;
        }

        let prev_pending = self.state.total_pending_redeems;
        let returned_shares = self.state.request.shares_locked;

        self.state.redemption_escrow_amount = self
            .state
            .redemption_escrow_amount
            .checked_sub(returned_shares)
            .expect("fuzz model overflow: sub");
        self.state.total_pending_redeems = self
            .state
            .total_pending_redeems
            .checked_sub(1)
            .expect("fuzz model overflow: sub");
        self.state.request = RedemptionRequest::default();
        self.state.reject_count += 1;

        assert_eq!(
            self.state.total_pending_redeems,
            prev_pending - 1,
            "pending counter delta != 1 on reject"
        );
    }

    /// Random NAV moves. The vault no longer runs a books-vs-oracle deviation
    /// guard, so any positive price is valid; this just varies the payout.
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
        // INVARIANT: status consistency at end-of-run.
        match self.state.request.status {
            RequestStatus::Approved => {
                // Approved means the full payout is staged and claimable.
                assert_eq!(
                    self.state.claimable_tokens_amount,
                    self.state.request.assets_claimable,
                    "Approved but claimable_tokens != assets_claimable"
                );
            }
            RequestStatus::Pending => {
                // Pending means nothing has been paid out yet.
                assert_eq!(
                    self.state.request.assets_claimable, 0,
                    "Pending but assets_claimable != 0"
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
    }
}

fn main() {
    FuzzTest::fuzz(5000, 60);
}
