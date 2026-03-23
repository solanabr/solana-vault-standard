# Testing Guide

Comprehensive guide to testing the Solana Vault Standard (SVS-1 through SVS-4).

## Overview

SVS uses a multi-layered testing strategy:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Test Pyramid                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                         ┌───────┐                               │
│                         │ E2E   │  Full lifecycle               │
│                        ─┴───────┴─                              │
│                      ┌─────────────┐                            │
│                      │ Integration │  Anchor tests              │
│                     ─┴─────────────┴─                           │
│                   ┌───────────────────┐                         │
│                   │   SDK Tests       │  TypeScript tests       │
│                  ─┴───────────────────┴─                        │
│                ┌───────────────────────────┐                    │
│                │    Unit Tests             │  Rust #[test]      │
│               ─┴───────────────────────────┴─                   │
│             ┌───────────────────────────────────┐               │
│             │      Fuzz Tests (Trident)         │  Invariants   │
│            ─┴───────────────────────────────────┴─              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Run all integration tests (256 tests)
anchor test

# Start proof backend first (required for SVS-3/SVS-4 CT tests)
cd proofs-backend && cargo run

# Run SDK tests
cd sdk && yarn test

# Run Rust unit tests
cargo test --manifest-path programs/svs-1/Cargo.toml

# Run proof backend tests (19 tests)
cd proofs-backend && cargo test

# Build fuzz tests
cd trident-tests && cargo build

# Run fuzz tests (simulation)
trident fuzz run fuzz_0  # SVS-1 math + modules
trident fuzz run fuzz_1  # SVS-2 stored balance
trident fuzz run fuzz_3  # SVS-3/4 CT state machine
trident fuzz run fuzz_svs5  # SVS-5 streaming yield + modules

# Run fuzz tests (actual program calls — requires anchor build -p svs_1)
trident fuzz run fuzz_2
```

## Test Categories

### Integration Tests (Anchor)

Located in `tests/`:

| File | Category | Tests |
|------|----------|-------|
| `svs-1.ts` | SVS-1 core + view functions | 26 |
| `svs-2.ts` | SVS-2 stored balance + sync | 35 |
| `svs-3.ts` | SVS-3 confidential live balance (CT deposit + withdraw/redeem) | 42 |
| `svs-4.ts` | SVS-4 confidential stored balance (CT deposit + sync + withdraw/redeem) | 43 |
| `edge-cases.ts` | Boundary conditions + view edges | 15 |
| `multi-user.ts` | Multi-user scenarios | 15 |
| `decimals.ts` | Token decimal handling | 12 |
| `yield-sync.ts` | Yield accrual & sync | 12 |
| `invariants.ts` | Mathematical invariants | 15 |
| `admin-extended.ts` | Admin operations | 10 |
| `full-lifecycle.ts` | End-to-end flows | 8 |
| **Total** | | **256** |

**Note:** SVS-3/SVS-4 confidential transfer tests require the proof backend running (`cd proofs-backend && cargo run`). Without it, CT-dependent tests are automatically skipped.

### Proof Backend Tests (Rust)

Located in `proofs-backend/src/`:

| Module | Category | Tests |
|--------|----------|-------|
| `proof_generator` | ZK proof generation (pubkey validity, equality, range, withdraw) | 19 |

### SDK Tests (TypeScript)

Located in `sdk/core/tests/`:

| File | Category | Tests |
|------|----------|-------|
| All test files | Full SDK coverage | 460 |
| **Total** | | **460** |

### Fuzz Tests (Trident)

Located in `trident-tests/`. Uses `svs-math` and `svs-fees` crates directly — no re-implemented math.

| Binary | Phase | Scope | Iterations |
|--------|-------|-------|------------|
| `fuzz_0` | 1-2 | SVS-1 math, multi-user, fees, caps, locks, access control | 5000 × 80 |
| `fuzz_1` | 3 | SVS-2 stored balance vs actual balance, sync, yield | 5000 × 80 |
| `fuzz_2` | 4 | SVS-1 actual program calls (dual-oracle) | 2000 × 40 |
| `fuzz_3` | 5 | SVS-3/4 CT state machine, SVS-4 sync timing | 5000 × 80 |
| `fuzz_svs5` | 6 | SVS-5 streaming yield, modules, timing edge cases | 5000 × 80 |

**fuzz_0 flows (SVS-1 simulation + modules):**
- Core: `flow_deposit`, `flow_mint`, `flow_withdraw`, `flow_redeem`, `flow_roundtrip_deposit_redeem`, `flow_inflation_attack`, `flow_zero_edge_cases`, `flow_max_value_edge_cases`
- Multi-user: `flow_multi_deposit`, `flow_multi_redeem` (5 users)
- Admin: `flow_pause`, `flow_unpause`, `flow_deposit_while_paused`
- Fees: `flow_init_fees` (validates BPS limits, fee + net = gross)
- Caps: `flow_init_caps`, `flow_deposit_exceeds_global_cap`, `flow_deposit_at_boundary`
- Locks: `flow_init_locks`, `flow_advance_clock`, `flow_redeem_while_locked`
- Access: `flow_init_access_whitelist`, `flow_init_access_blacklist`, `flow_freeze_user`, `flow_frozen_user_blocked`
- Invariants: share price monotonicity, user balance sum = total shares, no free money per user, cap enforcement

**fuzz_1 flows (SVS-2 stored balance):**
- `flow_deposit`, `flow_redeem`, `flow_external_yield`, `flow_sync`, `flow_deposit_before_sync`, `flow_sync_then_redeem`
- Invariants: stored ≤ actual, stale price gives more shares, sync increases redemption value

**fuzz_2 flows (actual program calls):**
- `flow_initialize`, `flow_deposit`, `flow_redeem`, `flow_pause`, `flow_unpause`, `flow_deposit_while_paused`
- `flow_preview_vs_actual_deposit` (oracle prediction as min_shares_out), `flow_max_deposit_honesty`
- Requires: `anchor build -p svs_1`

**fuzz_3 flows (CT state machine):**
- `flow_configure_account`, `flow_ct_deposit`, `flow_apply_pending`, `flow_ct_withdraw`
- `flow_double_apply_pending`, `flow_withdraw_insufficient_available`, `flow_freeze_account`, `flow_unfreeze_account`
- SVS-4: `flow_external_yield`, `flow_sync`, `flow_sync_with_pending_shares`
- Invariants: unconfigured users can't deposit, double apply is no-op, withdraw only from available, stored ≤ actual

**fuzz_svs5 flows (SVS-5 streaming yield + modules, 31 flows):**
- Core: `flow_initialize`, `flow_deposit`, `flow_redeem`, `flow_roundtrip_deposit_redeem`
- Streaming: `flow_distribute_yield`, `flow_checkpoint`, `flow_advance_clock`, `flow_deposit_mid_stream`
- Timing: `flow_extreme_clock_jump`, `flow_stream_replacement_rapid`, `flow_checkpoint_after_stream_end`, `flow_deposit_after_stream_ends`
- Operations: `flow_withdraw_during_stream`, `flow_mint_during_stream`, `flow_multiple_distribute_yield`
- Security: `flow_inflation_attack_during_stream`, `flow_pause_during_active_stream`, `flow_zero_edge_cases`, `flow_view_invariants_during_stream`
- Admin: `flow_pause`, `flow_unpause`
- Fees: `flow_init_fees` (validates BPS limits, fee + net = gross)
- Caps: `flow_init_caps`, `flow_deposit_exceeds_global_cap`, `flow_deposit_at_cap_boundary`
- Locks: `flow_init_locks`, `flow_redeem_while_locked`
- Access: `flow_init_access_whitelist`, `flow_init_access_blacklist`, `flow_freeze_user`, `flow_frozen_user_blocked`
- Invariants (13): share price monotonicity, effective ≥ base, strict mid-stream bounds, checkpoint idempotency, fee accounting, per-user yield bounds, cap enforcement, total withdrawn ≤ deposits + stream, post-checkpoint base == original + stream, share price after stream ≥ before

## Running Tests

### Integration Tests

```bash
# Run all tests
anchor test

# Run specific test file
anchor test --skip-local-validator -- --grep "core operations"

# Run with debug logging
RUST_LOG=debug anchor test

# Run keeping validator alive
anchor test --skip-local-validator
```

### SDK Tests

```bash
cd sdk

# Run all tests
yarn test

# Run specific test file
yarn test -- --grep "math"

# Run with verbose output
yarn test -- --reporter spec
```

### Unit Tests (Rust)

```bash
# Run math module tests
cargo test --manifest-path programs/svs-1/Cargo.toml -- math

# Run all unit tests
cargo test --manifest-path programs/svs-1/Cargo.toml

# Run with output
cargo test --manifest-path programs/svs-1/Cargo.toml -- --nocapture
```

### Fuzz Tests

```bash
cd trident-tests

# Build all fuzz binaries (verifies compilation)
cargo build

# Run individual fuzz binaries via Trident
trident fuzz run fuzz_0  # SVS-1 simulation (math, multi-user, modules)
trident fuzz run fuzz_1  # SVS-2 stored balance simulation
trident fuzz run fuzz_2  # SVS-1 actual program calls (requires svs_1.so)
trident fuzz run fuzz_3  # SVS-3/4 CT state machine simulation

# Run with debug logging
TRIDENT_FUZZ_DEBUG=1 trident fuzz run fuzz_0

# Run with metrics collection
FUZZING_METRICS=1 trident fuzz run fuzz_0
```

## Test Scenarios

### Core Operations (svs-1.ts)

Tests basic vault functionality:

```typescript
describe("SVS-1 Vault Core", () => {
  it("initializes vault correctly");
  it("deposits assets and receives shares");
  it("mints exact shares for assets");
  it("withdraws assets by burning shares");
  it("redeems shares for assets");
  it("preview functions return accurate values");
  it("view functions work correctly");
});
```

### Edge Cases (edge-cases.ts)

Tests boundary conditions:

```typescript
describe("Edge Cases", () => {
  it("rejects zero amount deposits");
  it("rejects deposits below minimum");
  it("handles maximum u64 values");
  it("rejects when slippage exceeded");
  it("handles empty vault state correctly");
  it("prevents unauthorized admin actions");
});
```

### Multi-User (multi-user.ts)

Tests multi-user interactions:

```typescript
describe("Multi-User Scenarios", () => {
  it("multiple users deposit proportionally");
  it("users receive proportional shares");
  it("one user redeeming doesn't affect others");
  it("last user can redeem all shares");
  it("share accounting remains consistent");
});
```

### Decimals (decimals.ts)

Tests different token decimal configurations:

```typescript
describe("Different Decimals", () => {
  it("handles 6-decimal tokens (USDC)");
  it("handles 9-decimal tokens (SOL)");
  it("handles 0-decimal tokens");
  it("calculates correct decimals_offset");
  it("rejects tokens with > 9 decimals");
});
```

### Yield/Sync (yield-sync.ts)

Tests yield accrual mechanics:

```typescript
describe("Yield and Sync", () => {
  it("sync updates total_assets");
  it("external transfers increase share value");
  it("existing holders benefit from yield");
  it("new depositors pay higher price");
  it("sync emits correct events");
});
```

### Invariants (invariants.ts)

Tests mathematical invariants:

```typescript
describe("Invariants", () => {
  it("deposit-redeem round trip never profits user");
  it("total shares equals sum of user balances");
  it("total assets matches vault balance");
  it("rounding always favors vault");
  it("virtual offset prevents inflation attack");
});
```

### Admin Extended (admin-extended.ts)

Tests admin operations:

```typescript
describe("Admin Extended", () => {
  it("authority can pause vault");
  it("pause blocks all operations");
  it("pause does NOT block view functions");
  it("authority can unpause vault");
  it("authority can transfer to new key");
  it("old authority rejected after transfer");
  it("new authority can operate");
});
```

### Full Lifecycle (full-lifecycle.ts)

Tests complete user journeys:

```typescript
describe("Full Lifecycle", () => {
  it("complete flow: init → deposit → yield → sync → redeem");
  it("vault survives complete exit and new deposits");
  it("sequential operations: deposit → mint → withdraw → redeem");
  it("stress test: many operations maintain invariants");
});
```

## Writing Tests

### Integration Test Template

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Svs1 } from "../target/types/svs_1";

describe("My Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Svs1 as Program<Svs1>;

  let vault: PublicKey;
  let assetMint: PublicKey;

  before(async () => {
    // Setup: create mints, fund accounts
  });

  it("does something", async () => {
    // Arrange
    const amount = new BN(1000_000);

    // Act
    const tx = await program.methods
      .deposit(amount, new BN(0))
      .accounts({ /* ... */ })
      .rpc();

    // Assert
    const vaultState = await program.account.vault.fetch(vault);
    expect(vaultState.totalAssets.toNumber()).to.equal(1000_000);
  });
});
```

### SDK Test Template

```typescript
import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { convertToShares, Rounding } from "../src/math";

describe("Math Functions", () => {
  it("converts assets to shares correctly", () => {
    // Arrange
    const assets = new BN(1000_000);
    const totalAssets = new BN(10_000_000);
    const totalShares = new BN(10_000_000_000);
    const decimalsOffset = 3;

    // Act
    const shares = convertToShares(
      assets,
      totalAssets,
      totalShares,
      decimalsOffset,
      Rounding.Floor
    );

    // Assert
    expect(shares.gt(new BN(0))).to.be.true;
  });
});
```

### Fuzz Test Template

```rust
use svs_math::{convert_to_shares, convert_to_assets, Rounding};
use trident_fuzz::fuzzing::*;

#[derive(Default, Clone)]
struct VaultTracker {
    initialized: bool,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    vault_tracker: VaultTracker,
}

#[flow_executor]
impl FuzzTest {
    #[flow]
    fn flow_deposit(&mut self) {
        if !self.vault_tracker.initialized { return; }

        let assets: u64 = (rand::random::<u64>() % 1_000_000_000).max(1000);

        // Use svs-math crate directly (not re-implemented math)
        let shares = match convert_to_shares(
            assets,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
            self.vault_tracker.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_add(assets);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_add(shares);

        assert!(shares > 0 || assets < 1000,
            "Positive deposit to non-empty vault yielded 0 shares");
    }

    #[end]
    fn end(&mut self) {
        assert!(self.vault_tracker.total_redeemed <= self.vault_tracker.total_deposited,
            "Redeemed more than deposited");
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}
```

## Test Utilities

### Helper Functions

```typescript
// tests/helpers.ts

export async function createVault(
  program: Program<Svs1>,
  assetMint: PublicKey,
  vaultId: BN
): Promise<{ vault: PublicKey; sharesMint: PublicKey }> {
  // Implementation
}

export async function fundAccount(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint
): Promise<PublicKey> {
  // Implementation
}

export function expectError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  // Implementation
}
```

### Test Fixtures

```typescript
// tests/fixtures.ts

export const USDC_DECIMALS = 6;
export const SOL_DECIMALS = 9;
export const MIN_DEPOSIT = 1000;

export interface VaultFixture {
  vault: PublicKey;
  sharesMint: PublicKey;
  assetMint: PublicKey;
  assetVault: PublicKey;
  authority: Keypair;
}

export async function setupVaultFixture(
  program: Program<Svs1>,
  decimals: number = USDC_DECIMALS
): Promise<VaultFixture> {
  // Setup complete vault environment
}
```

## Invariants to Test

### Share/Asset Conservation

```typescript
// Total shares should equal sum of all user balances
const totalSupply = await getMint(sharesMint).supply;
const userBalances = await getAllUserBalances();
expect(totalSupply).to.equal(sum(userBalances));
```

### Rounding Direction

```typescript
// Round-trip should never profit user
const initialAssets = new BN(1000_000);
const shares = await vault.deposit(initialAssets);
const finalAssets = await vault.redeem(shares);
expect(finalAssets.lte(initialAssets)).to.be.true;
```

### Virtual Offset Protection

```typescript
// Small deposit after large donation should yield minimal shares
await directTransfer(vault.assetVault, 1_000_000_000_000); // 1M USDC
const shares = await vault.deposit(1); // 1 lamport
expect(shares.toNumber()).to.equal(0); // Floor rounds to 0
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-action@stable

      - name: Install Solana
        run: |
          sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
          echo "$HOME/.local/share/solana/install/active_release/bin" >> $GITHUB_PATH

      - name: Install Anchor
        run: cargo install --git https://github.com/coral-xyz/anchor anchor-cli

      - name: Build
        run: anchor build

      - name: Test Integration
        run: anchor test

      - name: Test SDK
        run: cd sdk && yarn install && yarn test

      - name: Test Fuzz (short)
        run: cd trident-tests && cargo test
```

## Coverage

### Tracking Coverage

```bash
# Install grcov for Rust coverage
cargo install grcov

# Run with coverage
CARGO_INCREMENTAL=0 \
RUSTFLAGS='-Cinstrument-coverage' \
cargo test --manifest-path programs/svs-1/Cargo.toml

# Generate report
grcov . -s . --binary-path ./target/debug/ -t html --branch --ignore-not-existing -o ./coverage/
```

### Current Coverage

| Category | Coverage |
|----------|----------|
| Integration Tests (SVS-1/2/3/4) | 256 tests |
| Proof Backend Tests | 19 tests |
| SDK Tests | 460 tests |
| Fuzz Tests | 5 binaries, 70+ flows |
| Devnet Scripts (SVS-5) | 9 scripts, 50+ test cases |
| **Total** | **825+ test cases** |

## Debugging Tests

### Anchor Test Logs

```bash
# Enable debug logs
RUST_LOG=debug anchor test

# Show transaction logs
anchor test 2>&1 | grep "Program log:"
```

### SDK Test Debugging

```bash
# Run single test with verbose output
yarn test -- --grep "specific test" --reporter spec

# Debug with node inspector
node --inspect-brk node_modules/.bin/mocha tests/**/*.ts
```

### Fuzz Test Debugging

```bash
# Run with debug logging
TRIDENT_FUZZ_DEBUG=1 trident fuzz run fuzz_0

# Run with metrics
FUZZING_METRICS=1 trident fuzz run fuzz_0

# Build and check compilation
cd trident-tests && cargo build

# Check for banned patterns
grep -r 'unwrap()' trident-tests/fuzz_*/test_fuzz.rs  # should find nothing
```

## Best Practices

1. **Test in isolation** - Each test should set up its own state
2. **Use descriptive names** - Test names should describe the scenario
3. **Test edge cases** - Zero, max values, boundary conditions
4. **Test error paths** - Verify errors are thrown correctly
5. **Test invariants** - Mathematical properties that must always hold
6. **Clean up** - Reset state between tests when needed

## Key Invariants Reference

These mathematical invariants must ALWAYS hold:

### 1. Share Conservation
```
shares_mint.supply == sum(all user share balances)
```

### 2. Asset Conservation (SVS-1)
```
asset_vault.amount >= sum(all claimable assets)
```

### 3. Rounding Never Profits User
```
redeem(deposit(X)) <= X
withdraw(mint(Y)) <= Y
```

### 4. Share Price Monotonic (absent losses)
```
share_price(t2) >= share_price(t1)  when t2 > t1 and no losses
```

### 5. Virtual Offset Protection
```
For attacker donating D tokens to empty vault:
  shares_from_1_token <= 1 when D < offset
```

### 6. Stored Balance Consistency (SVS-2/4)
```
After sync(): vault.total_assets == asset_vault.amount
```

---

## Test File Naming Convention

| Pattern | Purpose | Example |
|---------|---------|---------|
| `svs-{N}.ts` | Core variant tests | `svs-1.ts`, `svs-3.ts` |
| `{feature}.ts` | Feature-specific | `decimals.ts`, `yield-sync.ts` |
| `{scenario}.ts` | Scenario-based | `multi-user.ts`, `full-lifecycle.ts` |
| `invariants.ts` | Mathematical properties | Always run |
| `edge-cases.ts` | Boundary conditions | Include in CI |

---

## Property-Based Testing with Trident

### Setup

```bash
# Install Trident
cargo install trident-cli

# Initialize in project
cd trident-tests
trident init
```

### Key Flows to Fuzz

| Binary | Flow Sequence | Property |
|--------|---------------|----------|
| `fuzz_0` | `initialize` → `deposit` → `redeem` | No value creation (round-trip) |
| `fuzz_0` | Multi-user deposits/redeems | Share balance sum = total, no free money |
| `fuzz_0` | `init_fees` → `deposit` → `redeem` | fee + net = gross, fees favor vault |
| `fuzz_0` | `init_caps` → `deposit` | total_assets ≤ global_cap |
| `fuzz_0` | `init_locks` → `deposit` → `advance_clock` → `redeem` | Lock enforced until expiry |
| `fuzz_0` | `pause` → `deposit` | Paused vault rejects all mutations |
| `fuzz_1` | `deposit` → `external_yield` → `sync` → `redeem` | Yield distributed proportionally |
| `fuzz_1` | `external_yield` → `deposit_before_sync` | Stale price ≥ shares vs fresh |
| `fuzz_2` | `initialize` → `deposit` → `preview_deposit` | Oracle matches program output |
| `fuzz_3` | `configure` → `ct_deposit` → `apply_pending` → `withdraw` | CT state machine validity |
| `fuzz_3` | `sync` with pending shares | Sync increases share price |
| `fuzz_svs5` | `distribute_yield` → `advance_clock` → `checkpoint` | Yield accrues linearly, checkpoint idempotent |
| `fuzz_svs5` | `deposit_mid_stream` / `withdraw_during_stream` / `mint_during_stream` | Mid-stream pricing uses interpolated balance |
| `fuzz_svs5` | `extreme_clock_jump` past stream end | Stream fully consumed, share price monotonic |
| `fuzz_svs5` | `stream_replacement_rapid` (3x in 3s) | Auto-checkpoint preserves yield |
| `fuzz_svs5` | `init_fees` → `deposit` → `redeem` | fee + net = gross during streaming |

### Invariant Summary

All fuzz binaries assert these properties:

```
# Share price monotonicity (fuzz_0)
price_after >= price_before  for every deposit/mint/withdraw/redeem

# Multi-user conservation (fuzz_0)
sum(user.shares_balance) + fee_shares == total_shares

# Fee accounting (fuzz_0)
fee + net == gross  for every fee application

# Stored balance (fuzz_1)
stored_total_assets <= actual_balance  at all times

# Preview consistency (fuzz_2)
deposit(assets, min_shares_out=oracle_prediction) succeeds

# CT state machine (fuzz_3)
unconfigured users cannot deposit
withdraw only from available balance (not pending)
double apply_pending is no-op

# Streaming yield (fuzz_svs5)
effective_total_assets >= base_assets  at all times
base < effective < base + stream  during active stream (strict)
checkpoint(checkpoint(x)) == checkpoint(x)  at same timestamp
total_withdrawn <= total_deposited + stream_yield
price_after_stream >= price_before_stream
```

---

## See Also

- [Architecture](./ARCHITECTURE.md) - Technical implementation
- [Security](./SECURITY.md) - Security considerations
- [Patterns](./PATTERNS.md) - Implementation patterns
- [SDK](./SDK.md) - SDK documentation
