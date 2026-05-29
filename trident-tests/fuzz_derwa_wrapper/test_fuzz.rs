//! derwa-wrapper Fuzz Tests — 1:1 wrap/unwrap invariant
//!
//! Property-based check of an in-memory state MODEL of the cPOOL ↔ dePOOL
//! bridge. NOTE: this is a model/spec check — it asserts the model's own
//! invariants and does NOT invoke the on-chain program via Trident. Invariants:
//! - `locked_supply == dePOOL.supply` holds across arbitrary sequences of
//!   `wrap(n)` and `unwrap(m)`
//! - `locked_supply == wrapper_locked_ata.amount` (no donation accounting drift)
//! - `unwrap(m)` rejects when `locked_supply < m` (InsufficientLockedSupply)
//! - `unwrap` is rejected when the destination has no valid attestation
//! - `wrap(0)` and `unwrap(0)` are rejected (ZeroAmount)
//! - Sum of (wraps − unwraps) over the lifetime equals current `locked_supply`

mod fuzz_accounts;
use fuzz_accounts::*;

use trident_fuzz::fuzzing::*;

#[derive(Clone, Default, Debug)]
struct WrapperState {
    locked_supply: u64,
    derwa_supply: u64,
    wrapper_locked_ata_amount: u64,
    investor_cpool: u64,
    investor_depool: u64,
    total_wrapped: u128,
    total_unwrapped: u128,
    investor_attested: bool,
    wrap_count: u64,
    unwrap_count: u64,
    unwrap_rejected_no_attestation: u64,
    unwrap_rejected_insufficient: u64,
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    state: WrapperState,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            state: WrapperState {
                investor_cpool: 1_000_000_000_000,
                investor_attested: true,
                ..Default::default()
            },
        }
    }

    #[init]
    fn start(&mut self) {
        self.state = WrapperState {
            investor_cpool: 1_000_000_000_000,
            investor_attested: true,
            ..Default::default()
        };
    }

    /// Mirror of wrap: investor transfers cPOOL → wrapper PDA + mints
    /// dePOOL 1:1. Source already passed Permissioned-mode attestation
    /// to hold cPOOL, so no extra check on wrap.
    #[flow]
    fn flow_wrap(&mut self) {
        if self.state.investor_cpool == 0 {
            return;
        }
        // Random amount in (0, investor_cpool]
        let amount: u64 = (rand::random::<u64>() % self.state.investor_cpool) + 1;

        let prev_locked = self.state.locked_supply;
        let prev_derwa = self.state.derwa_supply;
        let prev_ata = self.state.wrapper_locked_ata_amount;

        // INVARIANT: amount > 0 enforced upstream.
        assert!(amount > 0, "wrap(0) accepted");

        // Move cPOOL.
        self.state.investor_cpool = self.state.investor_cpool.checked_sub(amount).expect("fuzz model overflow: sub");
        self.state.wrapper_locked_ata_amount =
            self.state.wrapper_locked_ata_amount.checked_add(amount).expect("fuzz model overflow: add");

        // Mint dePOOL.
        self.state.investor_depool = self.state.investor_depool.checked_add(amount).expect("fuzz model overflow: add");
        self.state.derwa_supply = self.state.derwa_supply.checked_add(amount).expect("fuzz model overflow: add");

        // Update locked_supply.
        let new_locked = match self.state.locked_supply.checked_add(amount) {
            Some(v) => v,
            None => {
                // Overflow path mirrors on-chain `LockedSupplyOverflow` — reject.
                // Roll back.
                self.state.investor_cpool = self.state.investor_cpool.checked_add(amount).expect("fuzz model overflow: add");
                self.state.wrapper_locked_ata_amount = prev_ata;
                self.state.investor_depool = self.state.investor_depool.checked_sub(amount).expect("fuzz model overflow: sub");
                self.state.derwa_supply = prev_derwa;
                return;
            }
        };
        self.state.locked_supply = new_locked;
        self.state.total_wrapped = self.state.total_wrapped.checked_add(amount as u128).expect("fuzz model overflow: add");
        self.state.wrap_count += 1;

        // INVARIANT: locked_supply == dePOOL.supply (the core 1:1 invariant).
        assert_eq!(
            self.state.locked_supply, self.state.derwa_supply,
            "post-wrap locked_supply != dePOOL.supply"
        );
        // INVARIANT: locked_supply == wrapper_locked_ata.amount.
        assert_eq!(
            self.state.locked_supply, self.state.wrapper_locked_ata_amount,
            "post-wrap locked_supply != wrapper ATA balance"
        );
        // INVARIANT: locked_supply delta == amount.
        assert_eq!(
            self.state.locked_supply,
            prev_locked + amount,
            "wrap did not increment locked_supply by amount"
        );
    }

    /// Mirror of unwrap: burn dePOOL + release cPOOL — gated on the
    /// destination's attestation.
    #[flow]
    fn flow_unwrap(&mut self) {
        if self.state.investor_depool == 0 {
            return;
        }
        let amount: u64 = (rand::random::<u64>() % self.state.investor_depool) + 1;

        // INVARIANT: amount > 0 enforced upstream.
        assert!(amount > 0, "unwrap(0) accepted");

        if !self.state.investor_attested {
            // INVARIANT: unwrap rejected when destination has no attestation.
            self.state.unwrap_rejected_no_attestation += 1;
            return;
        }
        if self.state.locked_supply < amount {
            // INVARIANT: InsufficientLockedSupply rejection.
            self.state.unwrap_rejected_insufficient += 1;
            return;
        }

        let prev_locked = self.state.locked_supply;
        let prev_derwa = self.state.derwa_supply;
        let prev_ata = self.state.wrapper_locked_ata_amount;

        // Burn dePOOL.
        self.state.investor_depool = self.state.investor_depool.checked_sub(amount).expect("fuzz model overflow: sub");
        self.state.derwa_supply = self.state.derwa_supply.checked_sub(amount).expect("fuzz model overflow: sub");

        // Release cPOOL.
        self.state.wrapper_locked_ata_amount =
            self.state.wrapper_locked_ata_amount.checked_sub(amount).expect("fuzz model overflow: sub");
        self.state.investor_cpool = self.state.investor_cpool.checked_add(amount).expect("fuzz model overflow: add");

        // Update locked_supply.
        self.state.locked_supply = self.state.locked_supply.checked_sub(amount).expect("fuzz model overflow: sub");
        self.state.total_unwrapped = self.state.total_unwrapped.checked_add(amount as u128).expect("fuzz model overflow: add");
        self.state.unwrap_count += 1;

        // INVARIANT: core 1:1 invariant maintained after unwrap.
        assert_eq!(
            self.state.locked_supply, self.state.derwa_supply,
            "post-unwrap locked_supply != dePOOL.supply"
        );
        assert_eq!(
            self.state.locked_supply, self.state.wrapper_locked_ata_amount,
            "post-unwrap locked_supply != wrapper ATA balance"
        );
        assert_eq!(
            self.state.locked_supply,
            prev_locked - amount,
            "unwrap did not decrement locked_supply by amount"
        );
        // INVARIANT: dePOOL.supply also strictly decreased by amount.
        assert_eq!(
            self.state.derwa_supply,
            prev_derwa - amount,
            "dePOOL.supply did not decrement by amount"
        );
        assert_eq!(
            self.state.wrapper_locked_ata_amount,
            prev_ata - amount,
            "wrapper ATA did not decrement by amount"
        );
    }

    /// Toggle the destination's attestation status — simulates revoke /
    /// re-issue cycles. Unwrap must reject during the unattested window.
    #[flow]
    fn flow_toggle_attestation(&mut self) {
        self.state.investor_attested = !self.state.investor_attested;
    }

    #[end]
    fn end(&mut self) {
        // INVARIANT: locked_supply == dePOOL.supply at end of run.
        assert_eq!(
            self.state.locked_supply, self.state.derwa_supply,
            "Final: locked_supply {} != dePOOL.supply {}",
            self.state.locked_supply, self.state.derwa_supply
        );
        // INVARIANT: locked_supply == wrapper_locked_ata.amount.
        assert_eq!(
            self.state.locked_supply, self.state.wrapper_locked_ata_amount,
            "Final: locked_supply {} != wrapper ATA {}",
            self.state.locked_supply, self.state.wrapper_locked_ata_amount
        );
        // INVARIANT: lifetime conservation — locked_supply = wraps − unwraps.
        let net = self
            .state
            .total_wrapped
            .checked_sub(self.state.total_unwrapped).expect("fuzz model overflow: sub");
        assert_eq!(
            net as u64, self.state.locked_supply,
            "Final: wraps − unwraps {} != locked_supply {}",
            net, self.state.locked_supply
        );
    }
}

fn main() {
    FuzzTest::fuzz(5000, 60);
}
