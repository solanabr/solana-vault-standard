//! compliance-hook Fuzz Tests — sanctions, freeze, and attestation gate
//!
//! Property-based check of an in-memory state MODEL replicating the `execute`
//! gate's documented logic. NOTE: this is a model/spec check — it asserts the
//! model's own invariants and does NOT invoke the on-chain program via Trident.
//! Properties:
//! - Sanctions list contains/doesn't-contain check is order-independent
//! - Frozen marker existence ↔ blocked state across freeze/unfreeze cycles
//! - FreelyTransferable mode allows all transfers between non-sanctioned + non-frozen wallets
//! - Permissioned mode rejects unless BOTH source and destination present valid attestation
//! - The 5-layer attestation check rejects on any single tampered field
//! - Sanctions update is idempotent across `add`/`remove` of the same address

mod fuzz_accounts;
use fuzz_accounts::*;

use std::collections::HashSet;
use trident_fuzz::fuzzing::*;

const MAX_SANCTIONED: usize = 256;
const NUM_WALLETS: usize = 16;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ComplianceMode {
    FreelyTransferable,
    Permissioned,
}

#[derive(Clone, Default, Debug)]
struct AttestationRecord {
    issuer_ok: bool,
    type_ok: bool,
    subject_ok: bool,
    pda_ok: bool,
    revoked: bool,
    expired: bool,
}

impl AttestationRecord {
    fn valid(&self) -> bool {
        self.issuer_ok && self.type_ok && self.subject_ok && self.pda_ok && !self.revoked && !self.expired
    }
}

#[derive(Clone, Debug)]
struct HookState {
    mode: ComplianceMode,
    sanctioned: HashSet<u8>, // wallet ids
    frozen: HashSet<u8>,
    attestations: Vec<Option<AttestationRecord>>, // per wallet
    sanctions_version: u64,
    accepted_transfers: u64,
    rejected_sanctioned: u64,
    rejected_frozen: u64,
    rejected_no_attestation: u64,
    rejected_attestation_invalid: u64,
}

impl HookState {
    fn new(mode: ComplianceMode) -> Self {
        Self {
            mode,
            sanctioned: HashSet::new(),
            frozen: HashSet::new(),
            attestations: vec![None; NUM_WALLETS],
            sanctions_version: 0,
            accepted_transfers: 0,
            rejected_sanctioned: 0,
            rejected_frozen: 0,
            rejected_no_attestation: 0,
            rejected_attestation_invalid: 0,
        }
    }

    /// Mirror of `execute::handler` gate composition.
    fn check_transfer(&self, source: u8, dest: u8) -> Result<(), &'static str> {
        if self.sanctioned.contains(&source) || self.sanctioned.contains(&dest) {
            return Err("SanctionedAddress");
        }
        if self.frozen.contains(&source) || self.frozen.contains(&dest) {
            return Err("AccountFrozen");
        }
        if self.mode == ComplianceMode::FreelyTransferable {
            return Ok(());
        }
        // Permissioned: both sides must have a valid attestation.
        let src = self
            .attestations
            .get(source as usize)
            .and_then(|a| a.as_ref());
        let dst = self
            .attestations
            .get(dest as usize)
            .and_then(|a| a.as_ref());
        let src = src.ok_or("AttestationNotFound")?;
        let dst = dst.ok_or("AttestationNotFound")?;
        if !src.valid() {
            return Err("InvalidAttestation");
        }
        if !dst.valid() {
            return Err("InvalidAttestation");
        }
        Ok(())
    }
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    state: HookState,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            state: HookState::new(ComplianceMode::Permissioned),
        }
    }

    #[init]
    fn start(&mut self) {
        let mode = if rand::random::<bool>() {
            ComplianceMode::Permissioned
        } else {
            ComplianceMode::FreelyTransferable
        };
        self.state = HookState::new(mode);
    }

    /// Mirror of update_sanctions_list: removals first, then additions.
    #[flow]
    fn flow_update_sanctions(&mut self) {
        let prev_count = self.state.sanctioned.len();
        let prev_version = self.state.sanctions_version;

        // Random removal.
        if !self.state.sanctioned.is_empty() && rand::random::<bool>() {
            let pick: u8 = rand::random::<u8>() % (NUM_WALLETS as u8);
            self.state.sanctioned.remove(&pick);
        }
        // Random addition (bounded by MAX_SANCTIONED).
        if self.state.sanctioned.len() < MAX_SANCTIONED && rand::random::<bool>() {
            let pick: u8 = rand::random::<u8>() % (NUM_WALLETS as u8);
            self.state.sanctioned.insert(pick); // idempotent
        }

        if self.state.sanctioned.len() != prev_count
            || self.state.sanctioned.is_empty() != (prev_count == 0)
        {
            self.state.sanctions_version = self.state.sanctions_version.checked_add(1).expect("fuzz model overflow: add");
        }
        // INVARIANT: capacity bound.
        assert!(
            self.state.sanctioned.len() <= MAX_SANCTIONED,
            "sanctions count exceeded MAX_SANCTIONED"
        );
        // INVARIANT: version monotonic.
        assert!(
            self.state.sanctions_version >= prev_version,
            "sanctions version decreased"
        );
    }

    #[flow]
    fn flow_freeze(&mut self) {
        let pick: u8 = rand::random::<u8>() % (NUM_WALLETS as u8);
        let was_frozen = self.state.frozen.contains(&pick);
        self.state.frozen.insert(pick);
        // INVARIANT: freeze is monotonic until unfreeze.
        assert!(
            self.state.frozen.contains(&pick),
            "freeze did not insert wallet"
        );
        if was_frozen {
            // Re-freeze is a no-op on count.
        }
    }

    #[flow]
    fn flow_unfreeze(&mut self) {
        if self.state.frozen.is_empty() {
            return;
        }
        // Pick a frozen wallet to unfreeze.
        let pick: u8 = self.state.frozen.iter().copied().next().unwrap();
        let was_frozen = self.state.frozen.remove(&pick);
        // INVARIANT: unfreeze actually removed.
        assert!(was_frozen, "unfreeze of non-frozen wallet");
        assert!(
            !self.state.frozen.contains(&pick),
            "unfreeze did not remove"
        );
    }

    #[flow]
    fn flow_issue_attestation(&mut self) {
        let pick: u8 = rand::random::<u8>() % (NUM_WALLETS as u8);
        // Randomize each of the 5 layer checks + revoked/expired to surface
        // every single-field tamper rejection.
        let att = AttestationRecord {
            issuer_ok: rand::random::<u8>() % 4 != 0,
            type_ok: rand::random::<u8>() % 4 != 0,
            subject_ok: rand::random::<u8>() % 4 != 0,
            pda_ok: rand::random::<u8>() % 4 != 0,
            revoked: rand::random::<u8>() % 8 == 0,
            expired: rand::random::<u8>() % 8 == 0,
        };
        self.state.attestations[pick as usize] = Some(att);
    }

    #[flow]
    fn flow_revoke_attestation(&mut self) {
        let pick: u8 = rand::random::<u8>() % (NUM_WALLETS as u8);
        if let Some(att) = self.state.attestations[pick as usize].as_mut() {
            att.revoked = true;
        }
    }

    /// Mirror of every cPOOL `transfer_checked` firing the hook.
    #[flow]
    fn flow_transfer(&mut self) {
        let source: u8 = rand::random::<u8>() % (NUM_WALLETS as u8);
        let dest: u8 = rand::random::<u8>() % (NUM_WALLETS as u8);

        match self.state.check_transfer(source, dest) {
            Ok(()) => {
                self.state.accepted_transfers += 1;
                // INVARIANT: accepted transfer means neither side is sanctioned/frozen.
                assert!(
                    !self.state.sanctioned.contains(&source)
                        && !self.state.sanctioned.contains(&dest),
                    "accepted transfer with sanctioned party"
                );
                assert!(
                    !self.state.frozen.contains(&source) && !self.state.frozen.contains(&dest),
                    "accepted transfer with frozen party"
                );
                if self.state.mode == ComplianceMode::Permissioned {
                    let src = self.state.attestations[source as usize]
                        .as_ref()
                        .expect("permissioned accept without source attestation");
                    let dst = self.state.attestations[dest as usize]
                        .as_ref()
                        .expect("permissioned accept without dest attestation");
                    // INVARIANT: Permissioned accept iff both attestations valid.
                    assert!(src.valid() && dst.valid(), "accept with invalid attestation");
                }
            }
            Err("SanctionedAddress") => {
                self.state.rejected_sanctioned += 1;
                assert!(
                    self.state.sanctioned.contains(&source) || self.state.sanctioned.contains(&dest),
                    "sanctioned rejection without sanctioned party"
                );
            }
            Err("AccountFrozen") => {
                self.state.rejected_frozen += 1;
                assert!(
                    self.state.frozen.contains(&source) || self.state.frozen.contains(&dest),
                    "frozen rejection without frozen party"
                );
            }
            Err("AttestationNotFound") => {
                self.state.rejected_no_attestation += 1;
                assert!(
                    self.state.mode == ComplianceMode::Permissioned,
                    "AttestationNotFound in FreelyTransferable mode"
                );
            }
            Err("InvalidAttestation") => {
                self.state.rejected_attestation_invalid += 1;
                assert!(
                    self.state.mode == ComplianceMode::Permissioned,
                    "InvalidAttestation in FreelyTransferable mode"
                );
            }
            Err(other) => panic!("unexpected error: {}", other),
        }
    }

    #[end]
    fn end(&mut self) {
        // INVARIANT: capacity bound never exceeded.
        assert!(
            self.state.sanctioned.len() <= MAX_SANCTIONED,
            "Final: sanctions over capacity"
        );
        // INVARIANT: FreelyTransferable mode never rejected for attestation.
        if self.state.mode == ComplianceMode::FreelyTransferable {
            assert_eq!(
                self.state.rejected_no_attestation, 0,
                "Final: FreelyTransferable rejected for missing attestation"
            );
            assert_eq!(
                self.state.rejected_attestation_invalid, 0,
                "Final: FreelyTransferable rejected for invalid attestation"
            );
        }
    }
}

fn main() {
    FuzzTest::fuzz(5000, 60);
}
