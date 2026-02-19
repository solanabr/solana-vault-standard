# Solana Vault Standard (SVS) — Implementation Plan

## What We're Building

A **tokenized vault standard for Solana** — the ERC-4626 equivalent. Two core on-chain programs (live balance and stored balance), two alpha privacy variants, and a modular TypeScript SDK (`solana-vault`) where additional features like emergency withdrawal, fees, access control, and multi-asset support are handled as SDK-level modules — not baked into the programs.

The programs are already written. This plan is about **polishing, testing, packaging, and shipping** what exists.

---

## The Two Standards + Two Alpha Variants

```
CORE (Ship Now)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  SVS-1 — Live Balance Vault
    Assets stay in vault ATA. Share price = balance / supply.
    No sync, no trust assumption, lowest complexity.
    Use: lending pools, liquid staking, simple yield.

  SVS-2 — Stored Balance Vault (+ sync)
    Assets deployed elsewhere. Manager reports total_assets via sync().
    Trust assumption on sync caller.
    Use: yield aggregators, strategy vaults, fund managers.

ALPHA (Ship as Preview)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  SVS-3 — Private Live Balance Vault
    SVS-1 + Token-2022 Confidential Transfers for share balances.
    Use: private DeFi positions.

  SVS-4 — Private Stored Balance Vault
    SVS-2 + Token-2022 Confidential Transfers.
    Use: private strategy vaults, institutional funds.
```

**Sync question, resolved:** If 100% of assets live in the vault ATA → SVS-1. If assets leave the ATA (deployed to other protocols, bridged, managed off-chain) → SVS-2. That's it.

---

## SDK Modules (Plugin Architecture)

The on-chain programs are **minimal by design** — they implement the ERC-4626 interface and nothing else. Everything beyond core deposit/mint/withdraw/redeem is handled through **SDK modules** that compose on top of the base vault instructions. This keeps the programs lean, auditable, and CU-efficient.

### Module Map

Each module addresses a real use case. Modules are opt-in — integrators import only what they need.

```
@stbr/solana-vault
├── core/                    # Always included
│   ├── vault.ts             # SVS-1 base class
│   └── managed-vault.ts     # SVS-2 (extends vault, adds sync)
│
├── modules/
│   ├── fees/                # Management + performance fees
│   ├── access-control/      # Whitelist/blacklist depositors
│   ├── emergency/           # Emergency withdrawal when paused
│   ├── multi-asset/         # Multi-asset vault wrapper
│   ├── timelock/            # Timelock on sync, authority changes
│   ├── cap/                 # Deposit caps (per-user, global)
│   └── strategy/            # CPI helpers for deploying assets
│
└── alpha/
    ├── private-vault.ts     # SVS-3
    └── private-managed.ts   # SVS-4
```

### Module Details

**`fees/` — Fee Collection**
Use case: Vault operators charging management fees (annual %) and performance fees (% of yield).
How: SDK calculates fee shares on deposit/withdrawal client-side. Fee recipient is the vault authority or a designated fee account. Fees are skimmed as extra shares minted to the fee recipient during deposit/redeem operations.
Enables: Yield aggregators (Kamino-style), fund managers, protocol treasuries.

**`access-control/` — Whitelist/Blacklist**
Use case: Permissioned vaults where only approved addresses can deposit.
How: Uses the existing `Access` PDA pattern (`["access", vault, owner]`). SDK wraps the check — if Access PDA exists and is enabled, deposit proceeds. Otherwise, fails.
Enables: Institutional vaults, KYC-gated pools, DAO-member-only vaults.

**`emergency/` — Emergency Withdrawal**
Use case: Users need their funds when the vault is paused (protocol incident, migration).
How: SDK constructs a special withdrawal that bypasses the pause check but applies a penalty (configurable %, e.g., 1-5%). Penalty goes to vault reserves or is burned. Requires a separate on-chain instruction flag (`allow_emergency_withdraw` in vault config) set at initialization.
Enables: Safety net for all vault types. Users never fully locked out.

**`multi-asset/` — Multi-Asset Vaults**
Use case: A single vault that accepts multiple deposit tokens (e.g., USDC + USDT + SOL) and issues a unified share token.
How: Multi-asset wrapper creates N underlying SVS-1/SVS-2 vaults (one per asset) behind a single "meta-vault" interface. Deposits into any asset mint route to the correct sub-vault. Shares are fungible across all sub-vaults (meta-vault mints its own share token). Rebalancing between sub-vaults is a manager operation.
Enables: Basket products, index vaults, diversified yield, multi-collateral lending pools.

**`timelock/` — Timelocked Operations**
Use case: Prevent rug-pulls on managed vaults by timelocking critical operations.
How: SDK wraps `sync()`, `transfer_authority()`, and other admin calls with a propose → wait → execute pattern. Timelock PDA stores pending operations with an unlock timestamp.
Enables: Trustless SVS-2 vaults where users can verify no sync manipulation.

**`cap/` — Deposit Caps**
Use case: Limit vault size (risk management) or per-user deposits (fairness).
How: SDK checks `max_deposit()` on-chain view function + optional per-user cap stored in Access PDA. Rejects deposits exceeding either cap client-side before sending tx.
Enables: Bootstrapping new vaults, whale prevention, risk-limited strategies.

**`strategy/` — CPI Strategy Helpers**
Use case: SVS-2 vaults that deploy capital to other Solana protocols.
How: Pre-built CPI templates for common integrations — Marinade (stake SOL), Solend (lend USDC), Orca (LP), Raydium (LP), Jupiter (swap). SDK provides `strategy.deploy(protocol, amount)` and `strategy.harvest(protocol)` helpers that build the CPI transactions.
Enables: Yield aggregation, auto-compounding, cross-protocol strategies.

### Use Case → Module Matrix

| Use Case | Core | Fees | Access | Emergency | Multi-Asset | Timelock | Cap | Strategy |
|----------|------|------|--------|-----------|-------------|----------|-----|----------|
| Simple yield pool | SVS-1 | | | ✅ | | | | |
| Lending pool | SVS-1 | ✅ | | ✅ | | | ✅ | |
| Liquid staking | SVS-1 | ✅ | | ✅ | | | | |
| Yield aggregator | SVS-2 | ✅ | | ✅ | | ✅ | ✅ | ✅ |
| Fund manager | SVS-2 | ✅ | ✅ | ✅ | | ✅ | | ✅ |
| DAO treasury | SVS-2 | | ✅ | | | ✅ | | |
| Index vault | SVS-1 | ✅ | | ✅ | ✅ | | ✅ | |
| Multi-collateral pool | SVS-1 | ✅ | | ✅ | ✅ | | ✅ | |
| Private fund | SVS-3/4 | ✅ | ✅ | | | ✅ | | ✅ |

---

## Preserving the Existing Codebase

The 4 on-chain programs are **feature-complete**. The work ahead is polish, not rewrite.

### What We Keep (Don't Touch Unless Broken)

- **All 4 program lib.rs files** — instruction routing, account contexts
- **state.rs** — Vault and ConfidentialVault structs (211 / 270 bytes)
- **math.rs** — Virtual offset formula, mul_div, rounding logic (already fixed to u128)
- **error.rs** — Error codes
- **events.rs** — Event definitions
- **constants.rs** — MIN_DEPOSIT, seeds
- **instructions/** — All instruction handlers (initialize, deposit, mint, withdraw, redeem, admin, view)
- **PDA scheme** — `["vault", asset_mint, vault_id]`, `["shares", vault_pubkey]`
- **Anchor.toml** — Program IDs, test config (glob pattern already fixed)
- **Test files** — 9 TypeScript test files covering SVS-1, SVS-2, shared scenarios

### What Gets Polished

| Area | Work | Why |
|------|------|-----|
| Build | Fix warnings, fmt, clippy clean | Ship quality |
| Tests | Get all 9 test files green | Confidence |
| Fuzz | Verify round-trip invariant (u128 fix already applied) | Security |
| Math | Audit rounding edge cases, add unit tests | Correctness |
| Security | Account validation pass, no unwrap(), checked math audit | Ship quality |
| Docs | Update ARCHITECTURE.md, write per-variant specs | Developer UX |
| SDK | Package existing patterns into `@stbr/solana-vault` | Distribution |

### What's New (Additive Only)

- SDK package with module architecture
- Per-variant spec docs (SVS-1.md, SVS-2.md)
- INTEGRATION.md guide
- CI/CD GitHub Actions
- Module implementations (fees, access-control, emergency, etc.)

---

## Multi-Asset Vaults

Multi-asset support is **not an on-chain program change** — it's an SDK-level composition pattern.

### How It Works

A "multi-asset vault" is actually N single-asset SVS vaults behind a meta-vault SDK wrapper:

```
MetaVault (SDK-only concept)
├── SVS-1 Vault (USDC)     → shares_usdc
├── SVS-1 Vault (USDT)     → shares_usdt
└── SVS-1 Vault (SOL)      → shares_sol

MetaVault issues: meta_shares (fungible across all sub-vaults)
```

**Deposit flow**: User deposits USDC → SDK routes to the USDC sub-vault → receives sub-vault shares → meta-vault mints proportional meta-shares.

**Withdraw flow**: User redeems meta-shares → SDK calculates proportional claim across sub-vaults → redeems from each → returns assets.

**Rebalancing**: Manager can move allocation between sub-vaults (e.g., 50% USDC / 30% USDT / 20% SOL → 40% USDC / 40% USDT / 20% SOL). This is a withdraw-from-one-deposit-to-another operation.

**Why SDK-level**: Each sub-vault is a standard SVS-1/SVS-2. No program changes needed. The meta-vault is just a client-side accounting layer that tracks the mapping between meta-shares and sub-vault shares. Can optionally have an on-chain registry PDA for the meta-vault config if persistence is needed.

---

## Implementation Phases

### Phase 1: Stabilize SVS-1 (Foundation)
**Goal**: SVS-1 rock-solid, tests green, deployed to devnet.
**Effort**: 2-3 days
**Approach**: Fix and polish, don't rewrite.

- [ ] `anchor build` clean (zero warnings)
- [ ] `cargo fmt && cargo clippy -- -W clippy::all` passes
- [ ] `anchor test` — SVS-1 tests green
- [ ] Fix any broken test imports/config
- [ ] Verify math.rs u128 intermediates in all convert functions
- [ ] Verify rounding direction in every instruction
- [ ] Add unit tests for rounding edge cases (1-unit amounts, near-empty vault)
- [ ] Security pass: account validation, no unwrap(), checked arithmetic, stored bumps
- [ ] Fuzz tests pass 10+ minutes (round-trip invariant, inflation attack, overflow)
- [ ] Deploy SVS-1 to devnet

### Phase 2: Stabilize SVS-2 (Sync)
**Goal**: SVS-2 sync mechanics tested and verified.
**Effort**: 1-2 days
**Depends on**: Phase 1

- [ ] SVS-2 tests green
- [ ] Test: donation → sync() → share price increase
- [ ] Test: multi-user yield distribution after sync
- [ ] Test: sync timing attack mitigated by virtual offset
- [ ] Test: operations between syncs use stale total_assets correctly
- [ ] Deploy SVS-2 to devnet

### Phase 3: SDK — `@stbr/solana-vault`
**Goal**: Production SDK with module architecture.
**Effort**: 3-4 days
**Depends on**: Phase 1, Phase 2

#### 3.1 Core SDK
```
sdk/
├── src/
│   ├── index.ts              # Public exports
│   ├── core/
│   │   ├── vault.ts          # SolanaVault class (SVS-1)
│   │   └── managed-vault.ts  # ManagedVault class (SVS-2)
│   ├── instructions/
│   │   ├── initialize.ts
│   │   ├── deposit.ts
│   │   ├── mint.ts
│   │   ├── withdraw.ts
│   │   ├── redeem.ts
│   │   ├── sync.ts
│   │   ├── admin.ts
│   │   └── view.ts
│   ├── modules/
│   │   ├── fees.ts
│   │   ├── access-control.ts
│   │   ├── emergency.ts
│   │   ├── multi-asset.ts
│   │   ├── timelock.ts
│   │   ├── cap.ts
│   │   └── strategy.ts
│   ├── math.ts               # Client-side preview calculations
│   ├── pda.ts                # PDA derivation helpers
│   ├── types.ts              # Vault types, enums, configs
│   └── errors.ts             # Error code mapping
├── tests/
│   ├── vault.test.ts
│   ├── managed-vault.test.ts
│   ├── math.test.ts
│   └── modules/
│       ├── fees.test.ts
│       ├── multi-asset.test.ts
│       └── emergency.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

#### 3.2 Core API
```typescript
import { SolanaVault, ManagedVault } from '@stbr/solana-vault';
import { withFees, withCap, withEmergency } from '@stbr/solana-vault/modules';

// SVS-1: Simple vault
const vault = await SolanaVault.create(connection, payer, {
  assetMint: USDC_MINT,
  name: "USDC Yield Vault",
  symbol: "svUSDC",
  vaultId: 0,
});

// Deposit
const preview = await vault.previewDeposit(1_000_000000);
const tx = await vault.deposit(1_000_000000, { minSharesOut: preview * 0.99 });

// SVS-2: Managed vault with modules
const managed = await ManagedVault.create(connection, payer, { ... });
const vaultWithFees = withFees(managed, { managementBps: 200, performanceBps: 2000 });
const vaultWithCap = withCap(vaultWithFees, { globalCap: 10_000_000_000000 });

// Multi-asset
import { MultiAssetVault } from '@stbr/solana-vault/modules';
const metaVault = new MultiAssetVault(connection, [usdcVault, usdtVault, solVault]);
await metaVault.deposit(USDC_MINT, 1_000_000000);
```

#### 3.3 Module Implementation Priority
1. **fees** — most commonly needed
2. **cap** — simple, high value
3. **emergency** — critical safety feature
4. **access-control** — institutional demand
5. **multi-asset** — complex but differentiating
6. **timelock** — SVS-2 trust reduction
7. **strategy** — CPI templates (depends on partner protocols)

#### 3.4 Publish
- [ ] npm package: `@stbr/solana-vault`
- [ ] README with quickstart
- [ ] TypeDoc API documentation
- [ ] Examples folder with common use cases

### Phase 4: SVS-3/SVS-4 (Alpha)
**Goal**: Privacy variants functional with proof backend.
**Effort**: 3-4 days
**Depends on**: Phase 1, Phase 2
**Status**: Alpha — Token-2022 CT proof generation requires Rust backend until WASM bindings ship (mid-2026)

- [ ] Proof backend service (Rust, ElGamal + range proofs)
- [ ] SVS-3 tests green (configure_account, apply_pending, deposit, redeem with CT)
- [ ] SVS-4 tests green (SVS-3 + sync)
- [ ] Alpha SDK extension (`@stbr/solana-vault/alpha`)
- [ ] Clearly labeled as alpha in docs and exports

### Phase 5: Documentation + Polish
**Goal**: Ready for external developers.
**Effort**: 1-2 days

- [ ] `README.md` — Quickstart: install SDK, create vault, deposit, withdraw
- [ ] `docs/SVS-1.md` — Spec: accounts, instructions, math, use cases
- [ ] `docs/SVS-2.md` — Spec: sync mechanics, trust model, strategy patterns
- [ ] `docs/ARCHITECTURE.md` — Updated with module architecture
- [ ] `docs/MODULES.md` — Per-module documentation with examples
- [ ] `docs/SECURITY.md` — Attack vectors, mitigations, audit status
- [ ] `docs/INTEGRATION.md` — How to build on SVS
- [ ] AI slop cleanup pass
- [ ] CI/CD: GitHub Actions (build → fmt → clippy → test)

### Phase 6: Production
**Goal**: SVS-1 and SVS-2 mainnet-ready.
**Effort**: Ongoing

- [ ] External security audit
- [ ] Trident fuzz 30+ minutes clean
- [ ] CU profiling (all instructions fit single tx)
- [ ] Verifiable build: `anchor build --verifiable`
- [ ] Multisig upgrade authority (Squads v4)
- [ ] Mainnet deployment (explicit user confirmation required)
- [ ] At least 1 integration partner building on SVS

---

## Execution Order for Claude Code

```
PHASE 1 — SVS-1 Foundation (DON'T REWRITE, JUST FIX)
  1. anchor build — fix compilation errors only
  2. cargo fmt && cargo clippy — clean warnings
  3. Verify math.rs u128 intermediates (already fixed, just confirm)
  4. anchor test — fix broken tests, get SVS-1 green
  5. Add rounding edge-case unit tests
  6. Run fuzz tests — verify invariants hold
  7. Security audit pass (account validation, checked math)
  8. Deploy SVS-1 to devnet

PHASE 2 — SVS-2 Sync
  9. Get SVS-2 tests green
  10. Add yield/sync scenario tests
  11. Add sync timing attack tests
  12. Deploy SVS-2 to devnet

PHASE 3 — SDK (@stbr/solana-vault)
  13. Scaffold sdk/ with module architecture
  14. Implement core: SolanaVault + ManagedVault classes
  15. Implement modules: fees → cap → emergency → access-control
  16. Implement multi-asset module
  17. SDK unit + integration tests
  18. npm publish @stbr/solana-vault

PHASE 4 — Privacy (Alpha)
  19. Proof backend service
  20. SVS-3 tests green
  21. SVS-4 tests green
  22. Alpha SDK extension

PHASE 5 — Docs + Polish
  23. Per-variant spec docs
  24. Module documentation
  25. ARCHITECTURE.md, SECURITY.md, INTEGRATION.md
  26. AI slop cleanup
  27. CI/CD setup

PHASE 6 — Production
  28. External audit
  29. Extended fuzz testing
  30. Mainnet deployment (with explicit confirmation)
```

---

## Key Technical Specs (Quick Reference)

### Virtual Offset (Inflation Attack Protection)
```
offset = 10^(9 - asset_decimals)
USDC (6 decimals) → offset = 1,000
SOL (9 decimals)  → offset = 1

shares = assets × (total_shares + offset) / (total_assets + 1)
assets = shares × (total_assets + 1) / (total_shares + offset)
```

### Rounding (Always Favors Vault)
| Operation | Direction | Effect |
|-----------|-----------|--------|
| deposit | Floor | User gets fewer shares |
| mint | Ceiling | User pays more assets |
| withdraw | Ceiling | User burns more shares |
| redeem | Floor | User receives fewer assets |

### PDA Seeds
| Account | Seeds |
|---------|-------|
| Vault | `["vault", asset_mint, vault_id.to_le_bytes()]` |
| Shares Mint | `["shares", vault_pubkey]` |
| Asset Vault | ATA(shares_mint, asset_mint) |

### Program IDs
| Program | ID |
|---------|-----|
| SVS-1 | `SVS1VauLt1111111111111111111111111111111111` |
| SVS-2 | `SVS2VauLt2222222222222222222222222222222222` |
| SVS-3 | `SVS3VauLt3333333333333333333333333333333333` |
| SVS-4 | `SVS4VauLt4444444444444444444444444444444444` |

### State (Vault Account — 211 bytes)
```rust
pub struct Vault {
    pub authority: Pubkey,       // 32
    pub asset_mint: Pubkey,      // 32
    pub shares_mint: Pubkey,     // 32
    pub asset_vault: Pubkey,     // 32
    pub total_assets: u64,       // 8
    pub decimals_offset: u8,     // 1
    pub bump: u8,                // 1
    pub paused: bool,            // 1
    pub vault_id: u64,           // 8
    pub _reserved: [u8; 64],     // 64
}
```

---

## What's Explicitly Out of Scope (V1)

- **RWA vaults** — Separate bounty, separate standard. SVS-2 + access-control module is the foundation, but RWA-specific logic (oracle NAV, custodian reporting, compliance) lives elsewhere.
- **On-chain fee logic** — Fees are SDK-level. Programs stay minimal.
- **On-chain access control** — The `Access` PDA pattern exists in the codebase but is SDK-enforced. Programs don't gate deposits by default.
- **Governance** — No on-chain governance for vault parameters. Authority is a single keypair (or multisig via Squads).
- **Cross-chain** — No bridging or cross-chain vault abstraction.
