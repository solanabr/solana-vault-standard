# nav-oracle

## Overview

`nav-oracle` is a per-pool Net Asset Value (NAV) oracle program for credit-grade share pricing. It is the credit-markets reference implementation of the pluggable SVS oracle interface — a CreditVault pool reads it (like any compliant oracle) by configuring its `nav_oracle` + `oracle_program` to point here. An off-chain publisher (the protocol's NAV computation service) signs a canonical 133-byte payload with an Ed25519 keypair; the program verifies the signature on-chain by scanning the transaction for a matching `Ed25519Program` precompile instruction and then persists the new NAV into a per-pool `NavAccount` PDA.

Replay protection is enforced through strict sequence monotonicity, and a consecutive-publish deviation guard (`check_deviation`) bounds each new NAV to within `max_deviation_bps` of the previously published value. Stale-NAV protection is delegated to consumers (SVS-11 enforces `max_staleness` per-vault via the generic `read_oracle`). Publisher rotation is gated by the pool's **live `CreditVault.authority`** — read directly from the SVS-11 pool account on each call — so a compromised publisher key can be replaced without redeploying the program and without storing a separate rotation authority.

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
              │  2. timestamp within now ± 60          │
              │  3. scan instructions sysvar for       │
              │     Ed25519Program ix (any prior idx)  │
              │  4. strict-verify ix data matches      │
              │     (publisher, sig, payload)          │
              │  5. deviation guard vs last_published  │
              │  6. self-consistency check             │
              │  7. persist NavAccount; emit NavUpdated│
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
              │   via generic svs_oracle::read_oracle  │
              └────────────────────────────────────────┘
```

`NavAccount` is per-pool and PDA-derived from the SVS-11 CreditVault address. SVS-11 reads `NavAccount` as raw bytes — there is no CPI dependency between the two programs.

## Account Structures

### NavAccount (per-pool PDA)

PDA seeds: `[b"nav_oracle", pool_pubkey]`, where `pool_pubkey` is the SVS-11 CreditVault PDA address.

The struct **leads with the canonical 25-byte `SvsOraclePrice` header** (`version`, `nav_net`, `timestamp`, `sequence`) so SVS-11's generic `read_oracle` parses the NAV at one fixed window. The leading `version` byte (held at `1`) lets the reader fail closed on any future layout drift. All credit-market specifics follow the header. On-disk offsets below include the 8-byte Anchor discriminator; in payload space (discriminator excluded) the header occupies bytes `0..1` (version) / `1..9` (price) / `9..17` (timestamp) / `17..25` (sequence).

| Field | Type | Bytes | On-disk offset | Description |
|-------|------|-------|----------------|-------------|
| (discriminator) | `[u8; 8]` | 8 | 0 | Anchor account discriminator |
| `version` | `u8` | 1 | 8 | == `SvsOraclePrice.version`; canonical header version, held at `1` (header) |
| `nav_net` | `u64` | 8 | 9 | Net NAV == `SvsOraclePrice.price`; used by SVS-11 share-pricing math (header) |
| `timestamp` | `i64` | 8 | 17 | == `SvsOraclePrice.timestamp`; Unix seconds when NAV was computed (header) |
| `sequence` | `u64` | 8 | 25 | == `SvsOraclePrice.sequence`; strictly monotonic per pool (header) |
| `pool` | `Pubkey` | 32 | 33 | CreditVault PDA this NAV applies to |
| `nav_gross` | `u64` | 8 | 65 | Gross NAV before fees + loss provision |
| `ter_bps` | `u16` | 2 | 73 | Total Expense Ratio in basis points |
| `loss_provision_bps` | `u16` | 2 | 75 | Expected-loss provision in bps |
| `nav_type` | `u8` | 1 | 77 | `0` = monthly close, `1` = event-driven |
| `_padding` | `[u8; 7]` | 7 | 78 | Alignment padding (excluded from signature) |
| `publisher` | `Pubkey` | 32 | 85 | Authorized signer for `update` |
| `signature` | `[u8; 64]` | 64 | 117 | Ed25519 signature over canonical payload |
| `loan_tape_merkle_root` | `[u8; 32]` | 32 | 181 | Merkle root over receivable rows |
| `last_published_nav` | `u64` | 8 | 213 | Previous published `nav_net`; baseline for the deviation guard (`0` = genesis, guard skipped) |
| `max_deviation_bps` | `u16` | 2 | 221 | Max allowed consecutive-publish deviation in bps; set at `initialize`, never publisher-attested |

Size constant: `NavAccount::SPACE = 222 bytes` (`8 + 8 + 8 + 8 + 32 + 8 + 2 + 2 + 1 + 7 + 32 + 64 + 32 + 8 + 2`).

Self-consistency invariant (verified on every `update`):

```text
nav_net ≈ nav_gross × (1 − ter_bps/10000 − loss_provision_bps/10000)
```

within a 1-bps tolerance for integer-rounding effects (`verify_self_consistency`).

## Canonical Signing Payload (133 bytes)

The publisher signs **exactly** these 133 bytes. Off-chain signers MUST produce identical bytes — any byte-order, padding, or field-ordering deviation causes `InvalidSignature`. Padding bytes are intentionally excluded; the `signature`, `_padding`, `last_published_nav`, and `max_deviation_bps` fields are NOT part of the signed payload. Note the signing-payload byte order is unchanged by the header reordering — it still places `nav_gross` immediately after `nav_net` and groups `timestamp`/`sequence` after `nav_type`, independent of on-disk field order.

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

This layout is implemented by `NavAccount::signing_payload()` (state.rs). The TypeScript SDK mirrors it byte-for-byte as `buildSigningPayload` in `sdk/core/src/nav-oracle.ts`.

## Instructions

### initialize

Creates the `NavAccount` PDA at `[b"nav_oracle", pool]` and stores the publisher and the deviation ceiling. All NAV fields are zeroed; the first `update` populates real values.

**Args (`InitializeNavArgs`):**

```rust
pub struct InitializeNavArgs {
    pub max_deviation_bps: u16,
}
```

`max_deviation_bps` MUST be `> 0` (a zero ceiling would reject every consecutive publish); otherwise the handler fails with `InvalidDeviationConfig` (7013).

**Accounts (`InitializeNavAccount`):**

| Account | Mutability | Signer | Description |
|---------|------------|--------|-------------|
| `pool` | read | no | CreditVault PDA used as the NAV PDA seed; read in-handler to verify authority |
| `nav_account` | mut | no | The PDA being initialized (`init`) |
| `pool_authority` | read | yes | Must equal the pool's live `CreditVault.authority` (pool bytes 8..40) — gates per-pool init so an attacker cannot squat the NavAccount PDA for another pool. The check is skipped only when `pool` has no data (< 40 bytes) |
| `publisher` | read | no | Pubkey to install as the publisher |
| `payer` | mut | yes | Funds rent for the new PDA |
| `system_program` | read | no | System program |

There is no `key_rotation_authority` account — `initialize` no longer takes one. Authorization for both init and rotation now derives from the live `CreditVault.authority`.

### update

Publishes a new NAV for the pool. The handler runs the following checks in order:

1. **Sequence monotonicity** — `args.sequence > nav.sequence` or fail with `StaleSequence`. `args.nav_gross > 0` or fail with `ZeroNavGross`; `ter_bps + loss_bps < 10_000` or fail with `FeesExceedGross`.
2. **Timestamp bounds** — `args.timestamp` must be within `now ± 60` (60s clock-skew tolerance): above `now + 60` fails with `TimestampInFuture`, below `now - 60` fails with `TimestampInPast`.
3. **Ed25519 instruction scan** — load the instructions sysvar, then iterate every instruction at index `< current_idx`, returning the first whose `program_id == Ed25519Program::ID`. If none found, fail with `InvalidSignature`. The scan tolerates arbitrary preceding `ComputeBudget` instructions (priority-fee + unit-limit ixs are standard practice on mainnet).
4. **Canonical payload reconstruction** — build the expected 133-byte payload from `args` plus the on-chain `nav.pool` and `nav.publisher` (the signature field is zeroed — the message is signed before the signature exists, naturally).
5. **Strict ed25519 ix verification** (`verify_ed25519_ix_strict`) — confirm the matched ix:
   - has `count == 1` (exactly one signature verification in this ix)
   - has all three `instruction_index` fields equal to `0xFFFF` (data inlined in the same ix; prevents pointing the precompile at a different ix's bytes)
   - the embedded pubkey matches `nav.publisher`
   - the embedded signature matches `args.signature`
   - the embedded message matches the reconstructed payload exactly
6. **Deviation guard** (`check_deviation`) — `args.nav_net` must be within `max_deviation_bps` of `nav.last_published_nav`, else fail with `DeviationExceeded`. Genesis (`last_published_nav == 0`) is skipped — the first NAV is publisher-trusted. This is the consecutive-price bound the vault used to enforce; each pluggable oracle now self-checks it.
7. **Self-consistency** — `staged.verify_self_consistency()` (1bps tolerance on `nav_net ≈ nav_gross × (1 − ter − loss)`) or fail with `InconsistentNav`.
8. **Persist** — overwrite the entire `NavAccount` (committing `last_published_nav = args.nav_net` as the new baseline while preserving the init-only `max_deviation_bps`) and emit `NavUpdated`.

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
| `pool` | read | no | SVS-11 CreditVault PDA; owner + authority validated in-handler |
| `nav_account` | mut | no | `constraint = nav_account.pool == pool.key()` |
| `authority` | read | yes | Must equal the pool's live `CreditVault.authority` (pool bytes 8..40) |
| `new_publisher` | read | no | Pubkey to install (rejected if default) |

There is no `key_rotation_authority` — the handler reads the rotation gate live from the pool account on every call, with three on-chain checks: (1) `pool.owner == SVS_11_PROGRAM_ID`, (2) pool data length `>= 40`, (3) the `authority` signer's key equals the bytes at `pool[8..40]` (`CreditVault.authority`). A mismatch fails with `UnauthorizedRotation`. This unifies publisher rotation with the same multisig authority that governs the CreditVault, removing the separately-stored rotation key.

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

`pool` and `publisher` are NOT in `UpdateArgs` — they come from the on-chain `NavAccount` (single source of truth). This prevents an attacker from passing a self-chosen publisher key alongside a self-generated signature.

## Errors

| Code | Name | Description |
|------|------|-------------|
| 7000 | `StaleSequence` | Sequence must increment monotonically |
| 7001 | `InvalidSignature` | Signature does not match publisher key over canonical payload |
| 7002 | `InconsistentNav` | Self-consistency check failed: `nav_net != nav_gross × (1 − ter − loss)` |
| 7003 | `UnauthorizedRotation` | Publisher rotation requires the pool's live `CreditVault.authority` as signer |
| 7004 | `UnauthorizedPublisher` | Caller is not the registered publisher for this NavAccount |
| 7005 | `TimestampInFuture` | Timestamp must not be in the future |
| 7006 | `TimestampInPast` | Timestamp is too far in the past (> 60s skew) |
| 7007 | `FeesExceedGross` | `ter_bps + loss_provision_bps` must be `< 10_000` |
| 7008 | `ZeroNavGross` | `nav_gross` must be `> 0` |
| 7009 | `InvalidNewPublisher` | `new_publisher` cannot be the default pubkey |
| 7010 | `UnauthorizedPoolInit` | `initialize` signer must be the pool's `CreditVault.authority` |
| 7011 | `PoolAccountInvalid` | Pool account data is missing or shorter than the `CreditVault.authority` offset |
| 7012 | `DeviationExceeded` | New NAV deviates more than `max_deviation_bps` from the previously published NAV |
| 7013 | `InvalidDeviationConfig` | `max_deviation_bps` must be `> 0` |

## Events

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
- **Publisher rotation is gated by the pool's live `CreditVault.authority`.** `rotate_publisher` reads the rotation authority live from the SVS-11 pool account (bytes 8..40) on every call, after asserting the pool is owned by `SVS_11_PROGRAM_ID` and has `>= 40` bytes of data. Since `CreditVault.authority` is typically a governance / multisig vault, rotation inherits that program's multi-party consensus, and there is no separately-stored rotation key to keep in sync. A compromised publisher key can be replaced without protocol downtime.
- **Deviation guard.** Each consecutive publish must land within `max_deviation_bps` of `last_published_nav` (`check_deviation`). The ceiling is set once at `initialize` (and must be `> 0`); it is never publisher-attested, so a compromised publisher cannot widen its own bound. Genesis is exempt because there is no prior value to bound against.
- **Self-consistency check** acts as a sanity floor: a publisher who somehow signs nonsense (e.g. `nav_net > nav_gross`) cannot land it on-chain. The 1-bps tolerance accommodates integer rounding.
- **Stale-NAV protection is the consumer's responsibility.** This program does not reject old timestamps on read; it only bounds future timestamps on write. The consuming vault (SVS-11) enforces staleness via the generic `read_oracle` reader against its `max_staleness`.

## Integration with SVS-11

nav-oracle is one implementation of the pluggable SVS oracle interface (see [SVS-11.md](./SVS-11.md)). Because `NavAccount` leads with the canonical 25-byte `SvsOraclePrice` header (`version`, `nav_net` as `price`, `timestamp`, `sequence`), SVS-11 reads it through the SAME generic `svs_oracle::read_oracle` reader it uses for any compliant oracle — there is no nav-specific reader and no `oracle_source` selector. SVS-11's `approve_deposit` / `approve_redeem` take a single `oracle_account`, validated by `key == vault.nav_oracle` and `owner == vault.oracle_program`, then parse the header at on-disk bytes 8..33 (no CPI — raw bytes); a header whose `version` byte does not match is rejected. The publisher pubkey is read directly from `NavAccount.publisher`; SVS-11 stores no copy, so `rotate_publisher` cannot create a double-source-of-truth drift.

`read_oracle` enforces the generic invariants (positive price, `0 <= now - timestamp <= max_staleness`, sequence monotonicity vs the vault's `last_seen_nav_sequence`). After a successful approve_*, SVS-11 advances `last_seen_nav_sequence` (only when the published `sequence != 0`). The consecutive-price deviation bound is nav-oracle's own concern (`check_deviation`, above) — the vault does not re-implement it.

### Deployment sequence

To use nav-oracle as a pool's price source, configure the vault's `nav_oracle` (the `NavAccount` PDA) and `oracle_program` (this program) — either at `initialize_pool` or via `set_oracle` (which rotates the account and owner program together). Then:

1. nav-oracle `initialize` (creates `NavAccount` PDA, zero NAV, sets `max_deviation_bps`).
2. Publisher submits the first nav-oracle `update` (real NAV is now on-chain; genesis publish skips the deviation guard).
3. The pool's `approve_deposit` / `approve_redeem` read the `NavAccount` through the generic interface.

Switching a live pool to a different oracle uses the authority-gated `set_oracle`, which updates `nav_oracle` and `oracle_program` atomically.

## Constants

This program defines `NavAccount::SEED_PREFIX = b"nav_oracle"`, `NavAccount::SPACE = 222`, and `SVS_11_PROGRAM_ID` (the SVS-11 program ID that `rotate_publisher` requires the `pool` account to be owned by; kept in sync with `programs/svs-11/src/lib.rs::declare_id!`).

The staleness budget — `DEFAULT_MAX_NAV_STALENESS_SECS = 3_888_000` (45 days, accommodating monthly NAV cadence + grace) — lives in svs-11's constants (`programs/svs-11/src/constants.rs`); it is the default/ceiling for `CreditVault.max_staleness`, which the generic `read_oracle` enforces. See [SVS-11.md](./SVS-11.md) for the consumer-side staleness model.

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/nav-oracle/src/lib.rs` | Program entry — declares 3 instructions + `SVS_11_PROGRAM_ID` |
| `programs/nav-oracle/src/state.rs` | `NavAccount` struct (header-first layout) + canonical `signing_payload()` + `verify_self_consistency` |
| `programs/nav-oracle/src/error.rs` | `NavOracleError` codes (7000–7013) |
| `programs/nav-oracle/src/instructions/initialize.rs` | `InitializeNavAccount` context, `InitializeNavArgs`, handler |
| `programs/nav-oracle/src/instructions/update.rs` | `UpdateNav` context, handler, `verify_ed25519_ix_strict` + `check_deviation` helpers |
| `programs/nav-oracle/src/instructions/rotate_publisher.rs` | `RotatePublisher` context + handler (reads live `CreditVault.authority`) |
| `programs/nav-oracle/src/instructions/mod.rs` | Module re-exports |
| `modules/svs-oracle/src/price.rs` | Generic `SvsOraclePrice` header + `read_oracle` (the consumer-side reader SVS-11 uses) |

## See Also

- [SVS-11.md](./SVS-11.md) — CreditVault and oracle consumer
- [SVS-12.md](./SVS-12.md) — Tranched vault structure
- [SECURITY.md](./SECURITY.md) — Cross-program security model
