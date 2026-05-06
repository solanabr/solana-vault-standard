# nav-oracle

## Overview

`nav-oracle` is a per-pool Net Asset Value (NAV) oracle program for credit-grade share pricing. It is the canonical price source for SVS-11 CreditVault pools when `oracle_source == 1`. An off-chain publisher (the protocol's NAV computation service) signs a canonical 133-byte payload with an Ed25519 keypair; the program verifies the signature on-chain by scanning the transaction for a matching `Ed25519Program` precompile instruction and then persists the new NAV into a per-pool `NavAccount` PDA.

Replay protection is enforced through strict sequence monotonicity. Stale-NAV protection is delegated to consumers (SVS-11 enforces `max_nav_staleness_secs` per-vault). Publisher rotation is gated by an independent `key_rotation_authority` (typically a governance or multisig authority), so a compromised publisher key can be replaced without redeploying the program.

## Architecture

```
                ┌─────────────────────────────────────┐
                │   Off-chain NAV Publisher service   │
                │   (loan-tape ingest → NAV math)     │
                └─────────────┬───────────────────────┘
                              │ build_signing_payload (133 bytes)
                              │ ed25519 sign with publisher key
                              ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  Transaction (any layout, scanned in order):                  │
   │  [ComputeBudget? ] [ Ed25519Program verify ix ] [ update ix ] │
   └───────────────────────────────────────────────────────────────┘
                              │ on-chain handler
                              ▼
              ┌────────────────────────────────────────┐
              │      nav-oracle::update                │
              │  1. sequence > nav.sequence            │
              │  2. timestamp <= now + 60              │
              │  3. scan instructions sysvar for       │
              │     Ed25519Program ix (any prior idx)  │
              │  4. strict-verify ix data matches      │
              │     (publisher, sig, payload)          │
              │  5. self-consistency check             │
              │  6. persist NavAccount; emit NavUpdated│
              └────────────────────────────────────────┘
                              │
                              ▼
              ┌────────────────────────────────────────┐
              │   NavAccount PDA  (one per pool)       │
              │   seeds = [b"nav_oracle", pool]        │
              └────────────────────────────────────────┘
                              ▲ raw read (no CPI)
                              │
              ┌────────────────────────────────────────┐
              │   svs-11::approve_deposit / _redeem    │
              │   when CreditVault.oracle_source == 1  │
              └────────────────────────────────────────┘
```

`NavAccount` is per-pool and PDA-derived from the SVS-11 CreditVault address. SVS-11 reads `NavAccount` as raw bytes — there is no CPI dependency between the two programs.

## Account Structures

### NavAccount (per-pool PDA)

PDA seeds: `[b"nav_oracle", pool_pubkey]`, where `pool_pubkey` is the SVS-11 CreditVault PDA address.

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| (discriminator) | `[u8; 8]` | 8 | Anchor account discriminator |
| `pool` | `Pubkey` | 32 | CreditVault PDA this NAV applies to |
| `nav_net` | `u64` | 8 | Net NAV (used by SVS-11 share-pricing math) |
| `nav_gross` | `u64` | 8 | Gross NAV before fees + loss provision |
| `ter_bps` | `u16` | 2 | Total Expense Ratio in basis points |
| `loss_provision_bps` | `u16` | 2 | Expected-loss provision in bps |
| `nav_type` | `u8` | 1 | `0` = monthly close, `1` = event-driven |
| `_padding` | `[u8; 7]` | 7 | Alignment padding (excluded from signature) |
| `timestamp` | `i64` | 8 | Unix seconds when NAV was computed |
| `sequence` | `u64` | 8 | Strictly monotonic per pool |
| `publisher` | `Pubkey` | 32 | Authorized signer for `update` |
| `signature` | `[u8; 64]` | 64 | Ed25519 signature over canonical payload |
| `loan_tape_merkle_root` | `[u8; 32]` | 32 | Merkle root over receivable rows |
| `key_rotation_authority` | `Pubkey` | 32 | Governance / multisig authority for publisher rotation |

Size constant: `NavAccount::SPACE = 244 bytes` (`8 + 32 + 8 + 8 + 2 + 2 + 1 + 7 + 8 + 8 + 32 + 64 + 32 + 32`).

Self-consistency invariant (verified on every `update`):

```text
nav_net ≈ nav_gross × (1 − ter_bps/10000 − loss_provision_bps/10000)
```

within a 1-bps tolerance for integer-rounding effects (`verify_self_consistency`).

## Canonical Signing Payload (133 bytes)

The publisher signs **exactly** these 133 bytes. Off-chain signers MUST produce identical bytes — any byte-order, padding, or field-ordering deviation causes `InvalidSignature`. Padding bytes are intentionally excluded; the `signature`, `_padding`, and `key_rotation_authority` fields are NOT part of the signed payload.

| Offset | Bytes | Field | Type | Encoding |
|--------|-------|-------|------|----------|
| 0   | 32 | `pool` | `Pubkey` | raw 32-byte address |
| 32  | 8  | `nav_net` | `u64` | little-endian |
| 40  | 8  | `nav_gross` | `u64` | little-endian |
| 48  | 2  | `ter_bps` | `u16` | little-endian |
| 50  | 2  | `loss_provision_bps` | `u16` | little-endian |
| 52  | 1  | `nav_type` | `u8` | raw |
| 53  | 8  | `timestamp` | `i64` | little-endian |
| 61  | 8  | `sequence` | `u64` | little-endian |
| 69  | 32 | `publisher` | `Pubkey` | raw 32-byte address |
| 101 | 32 | `loan_tape_merkle_root` | `[u8; 32]` | raw |
|     | **133** | **TOTAL** | | |

This layout is implemented by `NavAccount::signing_payload()` (state.rs). The Python publisher service mirrors it as `build_signing_payload`.

## Instructions

### initialize

Creates the `NavAccount` PDA at `[b"nav_oracle", pool]` and stores the publisher and rotation authority. All NAV fields are zeroed; the first `update` populates real values.

**Accounts (`InitializeNavAccount`):**

| Account | Mutability | Signer | Description |
|---------|------------|--------|-------------|
| `pool` | read | no | CreditVault PDA used as the NAV PDA seed |
| `nav_account` | mut | no | The PDA being initialized (`init`) |
| `publisher` | read | no | Pubkey to install as the publisher |
| `key_rotation_authority` | read | no | Governance / multisig authority's vault PDA |
| `payer` | mut | yes | Funds rent for the new PDA |
| `system_program` | read | no | System program |

### update

Publishes a new NAV for the pool. The handler runs the following checks in order:

1. **Sequence monotonicity** — `args.sequence > nav.sequence` or fail with `StaleSequence`.
2. **Timestamp upper bound** — `args.timestamp <= now + 60` (60s clock-skew tolerance) or fail with `TimestampInFuture`.
3. **Ed25519 instruction scan** — load the instructions sysvar, then iterate every instruction at index `< current_idx`, returning the first whose `program_id == Ed25519Program::ID`. If none found, fail with `InvalidSignature`. The scan tolerates arbitrary preceding `ComputeBudget` instructions (priority-fee + unit-limit ixs are standard practice on mainnet).
4. **Canonical payload reconstruction** — build the expected 133-byte payload from `args` plus the on-chain `nav.pool` and `nav.publisher` (the signature field is zeroed — the message is signed before signing, naturally).
5. **Strict ed25519 ix verification** (`verify_ed25519_ix_strict`) — confirm the matched ix:
   - has `count == 1` (exactly one signature verification in this ix)
   - has all three `instruction_index` fields equal to `0xFFFF` (data inlined in the same ix; prevents pointing the precompile at a different ix's bytes)
   - the embedded pubkey matches `nav.publisher`
   - the embedded signature matches `args.signature`
   - the embedded message matches the reconstructed payload exactly
6. **Self-consistency** — `staged.verify_self_consistency()` (1bps tolerance on `nav_net ≈ nav_gross × (1 − ter − loss)`) or fail with `InconsistentNav`.
7. **Persist** — overwrite the entire `NavAccount` and emit `NavUpdated`.

Notable design choice: the publisher is **not** a signer on the `update` ix. The Ed25519 precompile is the only authorization gate. This lets the publisher submit through any relayer / fee payer.

**Accounts (`UpdateNav`):**

| Account | Mutability | Signer | Description |
|---------|------------|--------|-------------|
| `pool` | read | no | Used only as PDA seed |
| `nav_account` | mut | no | The PDA being updated |
| `instructions_sysvar` | read | no | `Sysvar1nstructions1111…` |

### rotate_publisher

Swaps the `publisher` pubkey. Old publisher is rejected on the next `update` (signatures over the new publisher bytes won't be produced by the old key, and the strict verifier compares the embedded pubkey against the on-chain `nav.publisher`).

**Accounts (`RotatePublisher`):**

| Account | Mutability | Signer | Description |
|---------|------------|--------|-------------|
| `pool` | read | no | PDA seed |
| `nav_account` | mut | no | `has_one = key_rotation_authority` |
| `key_rotation_authority` | read | yes | Must sign — typically a governance/multisig vault transaction |
| `new_publisher` | read | no | Pubkey to install |

The Anchor `has_one` constraint enforces that the signer matches the on-chain `key_rotation_authority`, otherwise the call fails with `UnauthorizedRotation`.

## Update Args (UpdateArgs)

```rust
pub struct UpdateArgs {
    pub nav_net: u64,
    pub nav_gross: u64,
    pub ter_bps: u16,
    pub loss_bps: u16,
    pub nav_type: u8,
    pub timestamp: i64,
    pub sequence: u64,
    pub loan_tape_merkle_root: [u8; 32],
    pub signature: [u8; 64],
}
```

`pool`, `publisher`, and `key_rotation_authority` are NOT in `UpdateArgs` — they come from the on-chain `NavAccount` (single source of truth). This prevents an attacker from passing a self-chosen publisher key alongside a self-generated signature.

## Errors

| Code | Name | Description |
|------|------|-------------|
| 7000 | `StaleSequence` | Sequence must increment monotonically |
| 7001 | `InvalidSignature` | Signature does not match publisher key over canonical payload |
| 7002 | `InconsistentNav` | Self-consistency check failed: `nav_net != nav_gross × (1 − ter − loss)` |
| 7003 | `UnauthorizedRotation` | Publisher rotation requires the configured `key_rotation_authority` signer |
| 7005 | `TimestampInFuture` | Timestamp must not be in the future |

## Events

All state-mutating instructions emit a typed Anchor event.

| Event | Emitted By | Fields |
|-------|-----------|--------|
| `NavAccountInitialized` | `initialize` | `pool: Pubkey`, `publisher: Pubkey`, `key_rotation_authority: Pubkey` |
| `NavUpdated` | `update` | (see struct below) |
| `PublisherRotated` | `rotate_publisher` | `pool: Pubkey`, `old_publisher: Pubkey`, `new_publisher: Pubkey`, `authority: Pubkey` |

### NavUpdated

Emitted by `update` after a successful publish.

```rust
#[event]
pub struct NavUpdated {
    pub pool: Pubkey,
    pub nav_net: u64,
    pub nav_gross: u64,
    pub ter_bps: u16,
    pub loss_provision_bps: u16,
    pub nav_type: u8,
    pub timestamp: i64,
    pub sequence: u64,
    pub publisher: Pubkey,
    pub loan_tape_merkle_root: [u8; 32],
}
```

`initialize` and `rotate_publisher` log via `msg!` but do not emit Anchor events.

## Security

- **Sequence monotonicity** prevents replay of older signed payloads. The check is strict (`args.sequence > nav.sequence`); equal sequences are rejected.
- **Ed25519 instruction scan** tolerates any number of preceding `ComputeBudget` instructions (priority-fee / unit-limit), so submitters can layer fee bumps without breaking signature verification. An earlier draft used `load_instruction_at_checked(0, ...)` which assumed Ed25519 was index 0 — that version is no longer in the tree, and the CI grep guard rejects any reintroduction of a loose `verify_ed25519_ix` helper.
- **Strict ix-data matching** (`verify_ed25519_ix_strict`): the precompile must inline `pubkey`, `signature`, and `message` data with all three `instruction_index` fields equal to `0xFFFF`. This prevents an attacker from satisfying the verify by having the precompile point at someone else's instruction data (cross-instruction data referencing).
- **Publisher ≠ signer of the update ix.** Authorization is purely cryptographic via the precompile. This means an arbitrary fee payer can submit `update`, and the publisher's keypair never needs SOL.
- **Publisher rotation is multi-party.** `key_rotation_authority` is typically a governance / multisig vault PDA — proposing, approving, and executing a rotation requires multi-party consensus. A compromised publisher key can be replaced without protocol downtime.
- **Self-consistency check** acts as a sanity floor: a publisher who somehow signs nonsense (e.g. `nav_net > nav_gross`) cannot land it on-chain. The 1-bps tolerance accommodates integer rounding.
- **Stale-NAV protection is the consumer's responsibility.** This program does not reject old timestamps on read; it only bounds future timestamps on write. SVS-11's `read_nav_oracle_price` enforces `max_nav_staleness_secs` from the CreditVault.

## Integration with SVS-11

SVS-11's `approve_deposit` and `approve_redeem` branch on `CreditVault.oracle_source` (see `programs/svs-11/src/instructions/approve_deposit.rs` line 108 and `approve_redeem.rs` line 169):

| `oracle_source` | Constant | Reader | Account read |
|-----------------|----------|--------|--------------|
| `0` | `ORACLE_SOURCE_MOCK` | `read_and_validate_oracle` | Legacy mock `nav_oracle` (24-byte layout: `price_per_share: u64` + `updated_at: i64`) |
| `1` | `ORACLE_SOURCE_NAV_ORACLE` | `read_nav_oracle_price` | `NavAccount` PDA from this program |

Critically, `read_nav_oracle_price` reads the `NavAccount` as **raw bytes** (no CPI). It manually validates owner, layout, pool binding, staleness, sequence monotonicity, and price deviation against the CreditVault's stored `last_seen_nav_price` / `last_seen_nav_sequence`. The publisher pubkey is read directly from `NavAccount.publisher` — SVS-11 does not store its own copy, which removes a double-source-of-truth class of bug after `rotate_publisher` runs.

After a successful approve_*, SVS-11 persists `last_seen_nav_sequence` and `last_seen_nav_price` to the CreditVault when (and only when) `oracle_source == ORACLE_SOURCE_NAV_ORACLE`.

### Deployment sequence

For a new pool migrating to nav-oracle, the order is:

1. SVS-11 `initialize_pool` (creates CreditVault with `oracle_source == 0`, mock oracle still in use).
2. nav-oracle `initialize` (creates `NavAccount` PDA, zero NAV).
3. Publisher submits the first nav-oracle `update` (real NAV is now on-chain).
4. SVS-11 `set_oracle_source(1)` — the configured governance authority flips the CreditVault to read from `NavAccount`.

Step 4 is reversible: in an emergency the governance authority can flip back to `set_oracle_source(0)` while a publisher issue is investigated.

## Constants

This program defines no public constants beyond `NavAccount::SEED_PREFIX = b"nav_oracle"` and `NavAccount::SPACE = 244`.

The staleness budget — `DEFAULT_MAX_NAV_STALENESS_SECS = 3_888_000` (45 days, accommodating monthly NAV cadence + grace) — lives in svs-11's constants (`programs/svs-11/src/constants.rs`) and is written into `CreditVault.max_nav_staleness_secs` at `initialize_pool`. See [SVS-11.md](./SVS-11.md) for the consumer-side staleness model.

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/nav-oracle/src/lib.rs` | Program entry — declares 3 instructions |
| `programs/nav-oracle/src/state.rs` | `NavAccount` struct + canonical `signing_payload()` + `verify_self_consistency` |
| `programs/nav-oracle/src/error.rs` | `NavOracleError` codes (7000–7005) |
| `programs/nav-oracle/src/instructions/initialize.rs` | `InitializeNavAccount` context + handler |
| `programs/nav-oracle/src/instructions/update.rs` | `UpdateNav` context, handler, and `verify_ed25519_ix_strict` helper |
| `programs/nav-oracle/src/instructions/rotate_publisher.rs` | `RotatePublisher` context + handler |
| `programs/nav-oracle/src/instructions/mod.rs` | Module re-exports |
| `programs/svs-11/src/oracle.rs` | Consumer-side `read_nav_oracle_price` (raw-byte reader) |

## See Also

- [SVS-11.md](./SVS-11.md) — CreditVault and oracle consumer
- [SVS-12.md](./SVS-12.md) — Tranched vault structure
- [SECURITY.md](./SECURITY.md) — Cross-program security model
