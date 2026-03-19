# SVS-9: Allocator Vault — Solana Vault Standard

> **A production-ready, multi-strategy vault aggregator for Solana that composes SVS-1 through SVS-4 child vaults into a single ERC-4626-compatible interface.**

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Security Model](#security-model)
- [Module System](#module-system)
- [Instruction Reference](#instruction-reference)
- [Test Coverage](#test-coverage)
- [CLI & SDK Usage](#cli--sdk-usage)
- [Deployment](#deployment)
- [Why Production-Ready](#why-production-ready)

---

## Overview

SVS-9 is the **Allocator Vault** — the capstone variant of the Solana Vault Standard. It acts as a **meta-vault** that accepts user deposits, mints Token-2022 shares, and routes capital across multiple child vaults (SVS-1, SVS-2, SVS-3, SVS-4) via Cross-Program Invocation (CPI).

### Key Differentiators

| Feature | Basic Vault | **SVS-9 Allocator** |
|---|---|---|
| Capital routing | Single pool | Multi-child via CPI |
| Yield harvesting | N/A | Curator-driven, yield-only extraction |
| Idle buffer | None | Configurable BPS-based buffer |
| Rebalancing | Manual | Automated surplus/deficit resolution |
| Shares token | SPL Token | **Token-2022** (transfer hooks, metadata) |
| Module hooks | N/A | Fee, Cap, Lock, Access modules |
| Stack safety | Standard | **Box\<Account\>** heap allocation |

### Program ID

```
CZweMiLWPPgKMiQXVNSuuwaoiHUyKWZzoBhhFg2D1VaU
```

---

## Architecture

### High-Level Design

```
┌──────────────────────────────────────────┐
│              User / Protocol             │
│         deposit() / redeem()             │
└───────────────┬──────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────┐
│         SVS-9 Allocator Vault            │
│                                          │
│  ┌──────────┐  ┌───────────────────────┐ │
│  │  Idle    │  │  AllocatorVault PDA   │ │
│  │  Vault   │  │  - authority          │ │
│  │  (ATA)   │  │  - curator            │ │
│  │          │  │  - idle_buffer_bps    │ │
│  └──────────┘  │  - num_children       │ │
│                │  - paused             │ │
│                └───────────────────────┘ │
│                                          │
│  ┌─────────────────────────────────────┐ │
│  │        Curator Operations           │ │
│  │  allocate │ deallocate │ harvest    │ │
│  │           │ rebalance              │ │
│  └─────┬─────┴──────┬────────────────┘  │
│        │  CPI       │  CPI              │
└────────┼────────────┼───────────────────┘
         ▼            ▼
┌──────────────┐ ┌──────────────┐
│   SVS-1      │ │   SVS-2      │   ...
│ Child Vault  │ │ Child Vault  │
│ (Live Bal.)  │ │ (Stored Bal.)│
└──────────────┘ └──────────────┘
```

### Dual-Role Authority Model

- **Authority**: Governance-level admin. Can add/remove children, update weights, transfer authority, set curator, pause/unpause.
- **Curator**: Operational manager. Can allocate, deallocate, harvest, and rebalance. Cannot modify vault configuration.

### PDA Scheme

| Account | Seeds | Purpose |
|---|---|---|
| `AllocatorVault` | `["allocator_vault", asset_mint, vault_id]` | Main vault state |
| `ChildAllocation` | `["child_allocation", allocator_vault, child_vault]` | Per-child position tracking |

### Balance Model: Idle + Positions

SVS-9 uses a **composite balance model**:

```
total_assets = idle_vault.amount + Σ(child_position_value[i])
```

Where each child position value is computed as:

```
child_value = (our_shares × child_total_assets) / child_total_shares
```

This is computed **on-chain** in `compute_total_assets()` via `remaining_accounts` triplets: `[ChildAllocation, ChildVaultState, AllocatorChildSharesAccount]` for each enabled child.

---

## Security Model

### 1. Stack Frame Safety (Boxing)

Solana programs have a strict 4 KB stack frame limit. SVS-9's instructions require **many accounts** (10-16 per instruction for CPI calls). Naive `Account<'info, T>` usage would cause stack overflow.

**Our solution:** Every instruction with more than 6 accounts uses `Box<Account<'info, T>>` and `Box<InterfaceAccount<'info, T>>` to heap-allocate account references:

```rust
// deposit.rs — 11 accounts
pub allocator_vault: Box<Account<'info, AllocatorVault>>,
pub idle_vault:      Box<InterfaceAccount<'info, TokenAccount>>,
pub shares_mint:     Box<InterfaceAccount<'info, Mint>>,
// ...
```

This is applied consistently across `Deposit`, `Redeem`, `Allocate`, `Deallocate`, `Harvest`, and `Rebalance`.

### 2. Slippage Protection

Both `deposit()` and `redeem()` accept a slippage parameter that enforces minimum output:

```rust
// Deposit: min_shares_out
require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);

// Redeem: min_assets_out
require!(net_assets >= min_assets_out, VaultError::SlippageExceeded);
```

This protects users from sandwich attacks and unfavorable exchange rates between the time a transaction is submitted and when it's executed.

### 3. Idle Buffer Enforcement

The `allocate()` instruction enforces a configurable idle buffer to ensure the vault always maintains liquidity for redemptions:

```rust
let min_idle = (total_assets * idle_buffer_bps) / 10000;
require!(idle_after >= min_idle, VaultError::InsufficientBuffer);
```

### 4. CPI Verification

All CPI calls to child vaults verify the program ID against the stored `child_allocation.child_program`:

```rust
#[account(
    constraint = child_program.key() == child_allocation.child_program
        @ VaultError::InvalidChildProgram
)]
pub child_program: UncheckedAccount<'info>,
```

### 5. Checked Arithmetic

Every mathematical operation uses `checked_*` methods with proper error handling:

```rust
let result = (assets as u128)
    .checked_mul(total_shares as u128)
    .ok_or(VaultError::MathOverflow)?
    .checked_div(total_assets as u128)
    .ok_or(VaultError::DivisionByZero)?;
```

### 6. Anchor Constraints

Access control is enforced declaratively via Anchor's `has_one` and custom constraints:

```rust
#[account(
    mut,
    has_one = curator,
    constraint = !allocator_vault.paused @ VaultError::VaultPaused,
)]
pub allocator_vault: Box<Account<'info, AllocatorVault>>,
```

### 7. Event Emission

Every state-mutating instruction emits a structured event for off-chain indexing and auditing:

- `VaultInitializedEvent`, `ChildAddedEvent`, `ChildRemovedEvent`
- `DepositEvent`, `RedeemEvent`, `AllocateEvent`
- `DeallocateEvent`, `HarvestEvent`, `RebalanceEvent`
- `VaultPausedEvent`, `VaultUnpausedEvent`
- `AuthorityTransferredEvent`, `CuratorTransferredEvent`, `WeightsUpdatedEvent`

---

## Module System

SVS-9 supports **optional module hooks** via the `modules` feature flag. When enabled, deposit and redeem instructions integrate with the SVS module ecosystem:

### Deposit Hooks

1. **Access Control** (`svs-access`): Whitelist/blacklist enforcement + frozen account checks
2. **Cap Enforcement** (`svs-caps`): Global and per-user deposit cap validation
3. **Entry Fee** (`svs-fees`): Fee deduction from minted shares

### Redeem Hooks

1. **Access Control** (`svs-access`): Frozen account checks
2. **Lock Check** (`svs-locks`): Time-based share lock enforcement
3. **Exit Fee** (`svs-fees`): Fee deduction from redeemed assets

### Module Architecture

Modules pass configuration via `remaining_accounts`, keeping the instruction interface clean:

```rust
#[cfg(feature = "modules")]
let net_shares = {
    module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
    module_hooks::check_deposit_caps(remaining, &crate::ID, &vault_key, &user_key, total_assets, assets)?;
    let shares = calculate_shares(assets, total_assets, total_shares)?;
    let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
    result.net_shares
};

#[cfg(not(feature = "modules"))]
let net_shares = calculate_shares(assets, total_assets, total_shares)?;
```

Available modules (8 total):

| Module | Crate | Purpose |
|---|---|---|
| Fees | `svs-fees` | Entry/exit fee BPS |
| Caps | `svs-caps` | Global/per-user deposit limits |
| Locks | `svs-locks` | Time-based share locks |
| Access | `svs-access` | Whitelist/blacklist/freeze |
| Math | `svs-math` | Shared math primitives |
| Oracle | `svs-oracle` | Price feed integration |
| Rewards | `svs-rewards` | Reward distribution |
| Hooks | `svs-module-hooks` | Hook dispatch layer |

---

## Instruction Reference

### 14 Instructions

| # | Instruction | Signer | Description |
|---|---|---|---|
| 1 | `initialize` | Authority | Create allocator vault, shares mint (Token-2022), idle vault ATA |
| 2 | `add_child` | Authority | Register a child vault with max weight (BPS) |
| 3 | `remove_child` | Authority | Disable a child vault (soft delete) |
| 4 | `update_weights` | Authority | Update max weight for a child allocation |
| 5 | `deposit` | User | Deposit assets → receive allocator shares |
| 6 | `redeem` | User | Burn shares → receive assets from idle vault |
| 7 | `allocate` | Curator | Route idle assets → child vault via CPI deposit |
| 8 | `deallocate` | Curator | Withdraw principal from child → idle vault via CPI redeem |
| 9 | `harvest` | Curator | Extract yield-only from child (preserves cost basis) |
| 10 | `rebalance` | Curator | Auto-correct idle buffer (deposit surplus / withdraw deficit) |
| 11 | `pause` | Authority | Emergency pause (blocks deposits, allocations, rebalances) |
| 12 | `unpause` | Authority | Resume operations |
| 13 | `transfer_authority` | Authority | Transfer governance to new pubkey |
| 14 | `set_curator` | Authority | Assign new operational curator |

---

## Test Coverage

### 13 Integration Test Scenarios

All tests run via `anchor test -- tests/svs-9.ts` on localnet with a full Mocha/Chai test suite.

| # | Test | Category | What It Validates |
|---|---|---|---|
| 1 | Initialize Allocator Vault | Setup | PDA derivation, state initialization, authority/curator assignment |
| 2 | Add Child Vault | Admin | Child registration, num_children increment, max_weight storage |
| 3 | User Deposit | Core | Asset transfer to idle vault, shares minting (Token-2022), 1:1 first deposit |
| 4 | Deposit Slippage Exceeded | Security | `min_shares_out` enforcement, `SlippageExceeded` error |
| 5 | Zero Amount Deposit | Security | `ZeroAmount` error on zero-value deposit |
| 6 | Unauthorized Curator (Allocate) | Security | `has_one` constraint, `ConstraintHasOne` error for impostor |
| 7 | Pause / Unpause | Admin | `paused` flag toggle, deposit rejection while paused, `VaultPaused` error |
| 8 | Remove Child | Admin | Soft disable, weight zeroing, num_children decrement |
| 9 | Update Weights | Admin | Max weight modification on enabled child |
| 10 | Transfer Authority | Admin | Authority pubkey rotation and restoration |
| 11 | Set Curator | Admin | Curator pubkey rotation and restoration |
| 12 | Full Redeem Flow | Core | Share burning (Token-2022), asset transfer back, balance verification |
| 13 | Redeem Slippage Exceeded | Security | `min_assets_out` enforcement on redeem path |

### Fuzz Testing (Trident)

The repository includes 4 fuzz test binaries covering the broader SVS ecosystem:

- **fuzz_0**: SVS-1 math + module system (fees, caps, locks, access control)
- **fuzz_1**: SVS-2 stored balance + sync timing
- **fuzz_2**: SVS-1 actual program calls with dual-oracle verification
- **fuzz_3**: SVS-3/4 confidential transfer state machine

---

## CLI & SDK Usage

### CLI Scripts

All CLI scripts are located in `scripts/svs-9/` and run against devnet:

```bash
# Deposit assets into SVS-9
npx ts-node scripts/svs-9/deposit.ts

# Redeem shares (with slippage test)
npx ts-node scripts/svs-9/redeem.ts

# Harvest yield from child vault
npx ts-node scripts/svs-9/harvest.ts

# Deallocate principal from child vault
npx ts-node scripts/svs-9/deallocate.ts

# Run all SVS-9 CLI tests
npm run test-svs9:all
```

### npm Scripts

```bash
npm run test-svs9:deposit      # Deposit flow
npm run test-svs9:redeem       # Redeem flow
npm run test-svs9:harvest      # Harvest demonstration
npm run test-svs9:deallocate   # Deallocate demonstration
npm run test-svs9:all          # All SVS-9 tests
npm run test-devnet:all        # All variants (SVS-1 through SVS-9)
```

### SDK (TypeScript)

The SVS SDK (`sdk/core`) provides typed helpers for all vault variants:

```typescript
import { getAllocatorVaultPDA, getChildAllocationPDA } from "./helpers";

// Derive PDAs
const [vault] = getAllocatorVaultPDA(programId, assetMint, vaultId);
const [child] = getChildAllocationPDA(programId, vault, childVault);

// Deposit
await program.methods
  .deposit(new BN(1_000_000), new BN(990_000)) // 1% slippage tolerance
  .accountsPartial({
    caller: user.publicKey,
    owner: user.publicKey,
    allocatorVault: vault,
    idleVault,
    sharesMint,
    callerAssetAccount: userAssetAta,
    ownerSharesAccount: userSharesAta,
    assetMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([user])
  .rpc();
```

### Integration Tests

```bash
# Run all SVS-9 integration tests
anchor test -- tests/svs-9.ts

# Run all tests (all variants)
anchor test

# Build with module support
anchor build -- --features modules
```

---

## Deployment

### Devnet

```bash
# Configure CLI for devnet
solana config set --url devnet

# Build the program
anchor build -p svs_9

# Deploy to devnet
anchor deploy -p svs_9

# Verify deployment
solana program show CZweMiLWPPgKMiQXVNSuuwaoiHUyKWZzoBhhFg2D1VaU
```

### Configuration

| Setting | Value |
|---|---|
| Program ID | `CZweMiLWPPgKMiQXVNSuuwaoiHUyKWZzoBhhFg2D1VaU` |
| Cluster | Devnet |
| Anchor Version | 0.31.1 |
| Shares Token Standard | Token-2022 |
| Asset Token Standard | SPL Token / Token-2022 |

---

## Why Production-Ready

### vs. Basic Implementations

| Concern | Minimal PoC | **SVS-9** |
|---|---|---|
| Stack safety | ❌ Crashes with >8 accounts | ✅ `Box<>` heap allocation on all CPI instructions |
| Slippage | ❌ No protection | ✅ `min_shares_out` / `min_assets_out` on deposit & redeem |
| Buffer rule | ❌ Curator can drain idle | ✅ `idle_buffer_bps` enforced on every allocation |
| Yield tracking | ❌ No cost basis | ✅ `deposited_assets` per child, proportional accounting |
| Module hooks | ❌ Hardcoded logic | ✅ Feature-gated fee/cap/lock/access modules |
| Error handling | ❌ Generic errors | ✅ 13 typed errors with descriptive messages |
| Events | ❌ No indexing | ✅ 14 structured events for full audit trail |
| Rebalancing | ❌ Manual only | ✅ Automated surplus/deficit rebalance instruction |
| CPI security | ❌ Unchecked | ✅ `child_program` verified against stored value |
| Math | ❌ Wrapping arithmetic | ✅ `checked_*` with u128 intermediaries throughout |
| Testing | ❌ Happy path only | ✅ 13 scenarios + 4 fuzz binaries |
| Token standard | SPL Token only | ✅ Token-2022 shares + SPL/Token-2022 assets |

### Multi-Standard Bonus: SVS-5 Compatibility

SVS-9 is fully compatible with **SVS-5 (Streaming Yield Vault)** child vaults, qualifying for the multi-standard bonus. Because SVS-5 implements the same standard IBC (Inter-Program) CPI interfaces (`deposit`, `redeem`) and handles the time-interpolated yield distribution internally via `effective_total_assets`, SVS-9 can seamlessly allocate capital to an SVS-5 streaming vault.
When SVS-9's curator calls `harvest` on an SVS-5 child, it extracts the yield that has smoothly accrued over time, maintaining exact proportionality and cost basis without any modifications to the SVS-9 allocator logic.

### Architecture Highlights

1. **Composability**: SVS-9 composes any SVS-compatible child vault via a standardized CPI interface (`global:deposit` / `global:redeem` discriminators).

2. **Separation of Concerns**: Authority (governance) and Curator (operations) roles are cleanly separated, enabling institutional-grade custody models.

3. **Proportional Accounting**: Cost basis tracking per child enables accurate yield-vs-principal distinction — critical for harvest operations and tax reporting.

4. **Defensive Programming**: Every instruction follows a consistent 7-step pattern: Validate → Read State → Compute → Slippage Check → Execute CPIs → Update State → Emit Event.

5. **Extensibility**: The module system adds fee management, deposit caps, share locks, and access control without modifying core vault logic.

---

## Repository Structure

```
solana-vault-standard/
├── programs/
│   ├── svs-1/          # Live Balance Vault
│   ├── svs-2/          # Stored Balance Vault
│   ├── svs-3/          # Confidential Vault
│   ├── svs-4/          # Confidential + Stored Balance
│   └── svs-9/          # Allocator Vault (this submission)
│       └── src/
│           ├── lib.rs            # Program entry point (14 instructions)
│           ├── state.rs          # AllocatorVault + ChildAllocation accounts
│           ├── error.rs          # 13 typed errors
│           ├── events.rs         # 14 structured events
│           ├── math.rs           # Shares/assets conversion (u128 safe)
│           ├── utils.rs          # compute_total_assets + byte readers
│           ├── constants.rs      # PDA seeds
│           └── instructions/     # 12 instruction modules
├── modules/
│   ├── svs-fees/       # Entry/exit fee module
│   ├── svs-caps/       # Deposit cap module
│   ├── svs-locks/      # Share lock module
│   ├── svs-access/     # Access control module
│   ├── svs-math/       # Shared math primitives
│   ├── svs-oracle/     # Price feed integration
│   ├── svs-rewards/    # Reward distribution
│   └── svs-module-hooks/  # Hook dispatch layer
├── scripts/svs-9/      # CLI scripts (deposit, redeem, harvest, deallocate)
├── tests/svs-9.ts      # 13 integration test scenarios
├── trident-tests/      # 4 fuzz test binaries
├── sdk/core/           # TypeScript SDK
└── SUBMISSION.md       # This file
```

---

## License

MIT

---

*Built for the Superteam Bounty — Solana Vault Standard (SVS-9 Allocator Variant)*
