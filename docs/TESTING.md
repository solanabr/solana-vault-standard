# Testing Guide

Comprehensive guide to testing the SVS-1 Solana Vault Standard.

## Overview

SVS-1 uses a multi-layered testing strategy:

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
# Run all integration tests
anchor test

# Run SDK tests
cd sdk && yarn test

# Run Rust unit tests
cargo test --manifest-path programs/svs-1/Cargo.toml

# Run fuzz tests
cd trident-tests && cargo test
```

## Test Categories

### Integration Tests (Anchor)

Located in `tests/`:

| File | Category | Tests |
|------|----------|-------|
| `svs-1.ts` | Core operations | 9 |
| `edge-cases.ts` | Boundary conditions | 12 |
| `multi-user.ts` | Multi-user scenarios | 15 |
| `decimals.ts` | Token decimal handling | 12 |
| `yield-sync.ts` | Yield accrual & sync | 12 |
| `invariants.ts` | Mathematical invariants | 15 |
| `admin-extended.ts` | Admin operations | 10 |
| `full-lifecycle.ts` | End-to-end flows | 8 |
| **Total** | | **~93** |

### SDK Tests (TypeScript)

Located in `sdk/tests/`:

| File | Category | Tests |
|------|----------|-------|
| `math.test.ts` | Conversion math | 18 |
| `pda.test.ts` | PDA derivation | 11 |
| `vault.test.ts` | Vault interfaces | 30 |
| `errors.test.ts` | Error handling | 25 |
| `events.test.ts` | Event parsing | 29 |
| **Total** | | **113** |

### Fuzz Tests (Trident)

Located in `trident-tests/`:

| Flow | Invariant |
|------|-----------|
| `flow_initialize` | Vault state setup |
| `flow_deposit` | Positive deposit → positive shares |
| `flow_redeem` | Cannot redeem more than available |
| `flow_conversion_check` | Round-trip doesn't create value |
| `end` | Shares don't exceed theoretical max |

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

# Run fuzz tests
cargo test

# Run with more iterations
FUZZ_ITERATIONS=10000 cargo test
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
use trident_fuzz::fuzzing::*;

#[derive(Default)]
struct VaultTracker {
    initialized: bool,
    total_assets: u64,
    total_shares: u64,
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    vault_tracker: VaultTracker,
}

#[flow_executor]
impl FuzzTest {
    #[flow]
    fn flow_deposit(&mut self) {
        if !self.vault_tracker.initialized { return; }

        let assets: u64 = rand::random::<u64>() % 1_000_000_000;
        let shares = self.calculate_shares(assets);

        // Invariant check
        assert!(shares > 0 || assets < 1000,
            "Invariant: deposit should yield shares");
    }

    #[end]
    fn end(&mut self) {
        // Final invariants
        assert!(self.vault_tracker.total_shares <= MAX_THEORETICAL);
    }
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
| Integration Tests | ~93 tests |
| SDK Tests | 113 tests |
| Fuzz Tests | 5 flows |
| **Total** | **~200+ test cases** |

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
# Print test progress
RUST_LOG=trident=debug cargo test

# Save failing inputs
PROPTEST_CASES=10000 cargo test 2>&1 | tee fuzz_output.log
```

## Best Practices

1. **Test in isolation** - Each test should set up its own state
2. **Use descriptive names** - Test names should describe the scenario
3. **Test edge cases** - Zero, max values, boundary conditions
4. **Test error paths** - Verify errors are thrown correctly
5. **Test invariants** - Mathematical properties that must always hold
6. **Clean up** - Reset state between tests when needed

## See Also

- [Architecture](./ARCHITECTURE.md) - Technical implementation
- [Security](./SECURITY.md) - Security considerations
- [SDK](./SDK.md) - SDK documentation
