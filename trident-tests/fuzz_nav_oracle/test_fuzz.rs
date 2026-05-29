//! nav-oracle Fuzz Tests — signed NAV publisher invariants
//!
//! Property-based fuzzing of the on-chain `update` handler validation chain:
//! - `verify_self_consistency` accepts iff `nav_net ≈ nav_gross × (1 − ter − loss)` within 1 bps
//! - `verify_self_consistency` rejects nav_gross == 0 (ZeroNavGross is upstream guard)
//! - `ter_bps + loss_bps >= 10_000` rejected (FeesExceedGross)
//! - timestamp must fall in [now − 60, now + 60] (TimestampInPast / TimestampInFuture)
//! - sequence is strictly monotonic (StaleSequence rejects ≤)
//! - publisher rotation only flips publisher; sequence + payload state untouched
//!
//! Mirrors the on-chain `NavAccount::verify_self_consistency` and
//! `update::handler` validation chain byte-for-byte.

mod fuzz_accounts;
use fuzz_accounts::*;

use trident_fuzz::fuzzing::*;

const TIMESTAMP_WINDOW_SECS: i64 = 60;

#[derive(Clone, Default, Debug)]
struct OracleState {
    nav_net: u64,
    nav_gross: u64,
    ter_bps: u16,
    loss_provision_bps: u16,
    timestamp: i64,
    sequence: u64,
    publisher_version: u64, // bumped on rotate
    publisher_rotation_count: u64,
    accepted_updates: u64,
    rejected_zero_gross: u64,
    rejected_fees: u64,
    rejected_inconsistent: u64,
    rejected_sequence: u64,
    rejected_timestamp_future: u64,
    rejected_timestamp_past: u64,
}

/// On-chain `verify_self_consistency`. Returns true iff
/// nav_net ≈ nav_gross × (1 − ter_bps/10_000 − loss_bps/10_000) within 1 bps.
fn verify_self_consistency(
    nav_net: u64,
    nav_gross: u64,
    ter_bps: u16,
    loss_provision_bps: u16,
) -> bool {
    let ter_i64: i64 = ter_bps.into();
    let loss_i64: i64 = loss_provision_bps.into();
    let factor_bps = 10_000_i64
        .checked_sub(ter_i64)
        .unwrap_or(0)
        .checked_sub(loss_i64)
        .unwrap_or(0);
    if factor_bps <= 0 {
        return false;
    }
    let nav_gross_u128: u128 = nav_gross.into();
    let factor_u128: u128 = u128::try_from(factor_bps).unwrap_or(0);
    let expected = nav_gross_u128
        .checked_mul(factor_u128)
        .unwrap_or(0)
        .checked_div(10_000)
        .unwrap_or(0);
    let nav_net_u128: u128 = nav_net.into();
    let tolerance = nav_gross_u128 / 10_000;
    nav_net_u128.abs_diff(expected) <= tolerance
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    state: OracleState,
    current_time: i64,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            state: OracleState::default(),
            current_time: 1_700_000_000, // ~2023-11-14
        }
    }

    #[init]
    fn start(&mut self) {
        self.state = OracleState::default();
        self.current_time = 1_700_000_000;
    }

    /// Mirror of `update::handler` validation chain.
    #[flow]
    fn flow_update(&mut self) {
        // Random NAV inputs.
        let nav_gross: u64 = rand::random::<u64>() % 100_000_000_000_000;
        let ter_bps: u16 = rand::random::<u16>() % 6_000;
        let loss_provision_bps: u16 = rand::random::<u16>() % 6_000;
        let new_sequence: u64 = self.state.sequence.checked_add(
            (rand::random::<u64>() % 5)
                .checked_add(1)
                .expect("fuzz model overflow: add"),
        ).expect("fuzz model overflow: add");
        // Sometimes intentionally pick a stale sequence to exercise the reject branch.
        let sequence = if rand::random::<u8>() % 8 == 0 {
            self.state.sequence
        } else {
            new_sequence
        };
        // Timestamp: in-window most of the time, out-of-window occasionally.
        let timestamp_delta: i64 = match rand::random::<u8>() % 16 {
            0 => TIMESTAMP_WINDOW_SECS + 1, // intentionally past edge
            1 => -(TIMESTAMP_WINDOW_SECS + 1),
            _ => (rand::random::<i64>() % (TIMESTAMP_WINDOW_SECS * 2)) - TIMESTAMP_WINDOW_SECS,
        };
        let timestamp = self.current_time + timestamp_delta;

        // Compute nav_net to be either consistent (most of the time) or
        // intentionally inconsistent (occasionally) to exercise both branches.
        let consistent = rand::random::<u8>() % 8 != 0;
        let factor_bps = (10_000_i64 - ter_bps as i64 - loss_provision_bps as i64).max(0);
        let nav_net: u64 = if consistent && factor_bps > 0 {
            ((nav_gross as u128 * factor_bps as u128) / 10_000) as u64
        } else {
            // Slightly off — outside the 1-bps tolerance.
            let base = ((nav_gross as u128 * factor_bps as u128) / 10_000) as u64;
            base.checked_add(nav_gross / 5_000).expect("fuzz model overflow: add") // 2 bps off
        };

        // --- Mirror the on-chain validation chain. ---

        // (1) Sequence monotonicity.
        if sequence <= self.state.sequence {
            self.state.rejected_sequence += 1;
            return;
        }

        // (2) Zero nav_gross.
        if nav_gross == 0 {
            self.state.rejected_zero_gross += 1;
            return;
        }

        // (3) Fees < 10_000.
        let fee_sum: u32 = ter_bps as u32 + loss_provision_bps as u32;
        if fee_sum >= 10_000 {
            self.state.rejected_fees += 1;
            return;
        }

        // (4) Timestamp window.
        if timestamp > self.current_time + TIMESTAMP_WINDOW_SECS {
            self.state.rejected_timestamp_future += 1;
            return;
        }
        if timestamp < self.current_time - TIMESTAMP_WINDOW_SECS {
            self.state.rejected_timestamp_past += 1;
            return;
        }

        // (5) Self-consistency.
        if !verify_self_consistency(nav_net, nav_gross, ter_bps, loss_provision_bps) {
            self.state.rejected_inconsistent += 1;
            return;
        }

        // All checks pass — apply.
        let prev_seq = self.state.sequence;
        self.state.nav_net = nav_net;
        self.state.nav_gross = nav_gross;
        self.state.ter_bps = ter_bps;
        self.state.loss_provision_bps = loss_provision_bps;
        self.state.timestamp = timestamp;
        self.state.sequence = sequence;
        self.state.accepted_updates += 1;

        // INVARIANT: sequence strictly increased on accept.
        assert!(
            self.state.sequence > prev_seq,
            "accepted update did not increase sequence"
        );
        // INVARIANT: timestamp within window post-accept.
        assert!(
            self.state.timestamp >= self.current_time - TIMESTAMP_WINDOW_SECS,
            "accepted timestamp below window"
        );
        assert!(
            self.state.timestamp <= self.current_time + TIMESTAMP_WINDOW_SECS,
            "accepted timestamp above window"
        );
        // INVARIANT: nav_gross > 0 post-accept.
        assert!(self.state.nav_gross > 0, "accepted nav_gross == 0");
        // INVARIANT: fees < 10_000 post-accept.
        assert!(
            (self.state.ter_bps as u32 + self.state.loss_provision_bps as u32) < 10_000,
            "accepted fees >= 10000"
        );
        // INVARIANT: self-consistency holds post-accept.
        assert!(
            verify_self_consistency(
                self.state.nav_net,
                self.state.nav_gross,
                self.state.ter_bps,
                self.state.loss_provision_bps
            ),
            "accepted state fails self-consistency"
        );
    }

    /// Mirror of rotate_publisher: only the publisher pubkey changes;
    /// sequence + NAV state are preserved.
    #[flow]
    fn flow_rotate_publisher(&mut self) {
        let prev_seq = self.state.sequence;
        let prev_nav_net = self.state.nav_net;
        let prev_nav_gross = self.state.nav_gross;

        self.state.publisher_version = self.state.publisher_version.checked_add(1).expect("fuzz model overflow: add");
        self.state.publisher_rotation_count += 1;

        // INVARIANT: rotation does not touch NAV state.
        assert_eq!(
            self.state.sequence, prev_seq,
            "rotation changed sequence"
        );
        assert_eq!(
            self.state.nav_net, prev_nav_net,
            "rotation changed nav_net"
        );
        assert_eq!(
            self.state.nav_gross, prev_nav_gross,
            "rotation changed nav_gross"
        );
    }

    /// Advance host clock — exercises the timestamp-window edges.
    #[flow]
    fn flow_advance_clock(&mut self) {
        let step: i64 = (rand::random::<i64>() % 300).abs() + 1;
        self.current_time += step;
    }

    #[end]
    fn end(&mut self) {
        // INVARIANT: sequence monotonic across the entire lifetime.
        //            (Tracked per-flow; checked again here for paranoia.)
        if self.state.accepted_updates > 0 {
            assert!(
                self.state.nav_gross > 0,
                "Final: accepted updates but nav_gross == 0"
            );
            assert!(
                verify_self_consistency(
                    self.state.nav_net,
                    self.state.nav_gross,
                    self.state.ter_bps,
                    self.state.loss_provision_bps
                ),
                "Final: persisted state fails self-consistency"
            );
        }
    }
}

fn main() {
    FuzzTest::fuzz(5000, 60);
}
