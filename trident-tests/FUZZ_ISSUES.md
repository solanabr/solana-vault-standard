# Trident Fuzz Test Status

## Current Status: ✅ Full Suite (5 Phases)

| Binary | Phase | Coverage | Type |
|--------|-------|----------|------|
| `fuzz_0` | 1-2 | SVS-1 math + modules | Simulation |
| `fuzz_1` | 3 | SVS-2 stored balance + sync | Simulation |
| `fuzz_2` | 4 | SVS-1 actual program calls | Program calls |
| `fuzz_3` | 5 | SVS-3/4 CT state machine | Simulation |

## Running Fuzz Tests

```bash
cd trident-tests

# Phase 1-2: SVS-1 simulation (math, multi-user, fees, caps, locks, access)
trident fuzz run fuzz_0

# Phase 3: SVS-2 stored balance simulation
trident fuzz run fuzz_1

# Phase 4: SVS-1 actual program calls (requires: anchor build -p svs_1)
trident fuzz run fuzz_2

# Phase 5: SVS-3/4 CT state machine simulation
trident fuzz run fuzz_3
```

## Phase 1: SVS-1 Simulation (fuzz_0)

### 1A: Uses `svs-math` crate directly
Math helpers replaced with `svs_math::convert_to_shares()` / `convert_to_assets()` calls.

### 1B: Share price monotonicity
Every mutating flow (deposit, mint, withdraw, redeem) captures price before/after and asserts `price_after >= price_before`.

### 1C: Multi-user tracking
5-user state tracking with per-user `shares_balance`, `cumulative_deposited`, `cumulative_redeemed`. End invariants: sum matches total, no free money per-user.

### 1D: Admin operations
`flow_pause`, `flow_unpause`, `flow_deposit_while_paused`. All mutating flows check `paused` flag.

### 1E: Increased iterations
`FuzzTest::fuzz(5000, 80)` — up from `(2000, 50)`.

## Phase 2: Module System Fuzzing (fuzz_0)

### 2A: Fee module
- `flow_init_fees`: Fuzzes entry/exit BPS (0-1500), values > MAX rejected
- Entry/exit fees applied via `svs_fees::apply_entry_fee` / `apply_exit_fee`
- Invariant: `fee + net == gross`

### 2B: Cap module
- `flow_init_caps`, `flow_deposit_exceeds_global_cap`, `flow_deposit_at_boundary`
- Invariant: `total_assets <= global_cap`

### 2C: Lock module
- `flow_init_locks`, `flow_advance_clock`, `flow_redeem_while_locked`
- Simulated clock with per-user lock enforcement

### 2D: Access control
- Whitelist, blacklist, freeze modes
- Invariant: blocked users cannot deposit or withdraw

## Phase 3: SVS-2 Stored Balance (fuzz_1)

Models `stored_total_assets` vs `actual_balance` divergence:
- `flow_external_yield`: Increases actual without updating stored
- `flow_sync`: Sets stored = actual
- `flow_deposit_before_sync`: Verifies stale price gives more shares
- `flow_sync_then_redeem`: Verifies post-sync redemption value increases
- Invariant: `stored <= actual` always

## Phase 4: Actual Program Calls (fuzz_2)

Dual-oracle architecture: simulation oracle predicts results, actual program executes instructions, divergences are detected.

- Uses generated instruction builders from `types.rs`
- Initializes real vault, asset mint, token accounts via Trident SVM
- `flow_preview_vs_actual_deposit`: Uses oracle prediction as `min_shares_out`
- `flow_max_deposit_honesty`: View function must not fail on active vault
- `flow_deposit_while_paused`: Must fail when paused

**Prerequisites:** `anchor build -p svs_1` must produce `target/deploy/svs_1.so`

## Phase 5: CT State Machine (fuzz_3)

Fuzzes confidential transfer state machine transitions without ZK proofs:
- `flow_configure_account` -> `flow_ct_deposit` -> `flow_apply_pending` -> `flow_ct_withdraw`
- Deposit without `configure_account` blocked
- Double `apply_pending` is no-op
- Withdraw only from available balance (not pending)
- SVS-4: sync timing relative to CT operations

## Historical Issues

### Fixed: Round-trip free assets (Phase 1)
**Root cause:** `flow_mint` allowed huge random share mints that yielded 0 assets, skewing vault ratio.
**Fix:** Mint capped to 10% of supply, 0-asset mints skipped, ratio degradation guard.

### Fixed: Duplicate types (initial setup)
**Root cause:** `trident fuzz refresh` merged all 4 SVS programs into one types.rs.
**Fix:** Extracted SVS-1 only. `Trident.toml` only references SVS-1.
