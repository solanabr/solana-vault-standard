# Solana Vault Standard (SVS) — Implementation Plan

## Status

Phases 1-2 are complete. Programs are built, tested, and deployed to devnet.

The SDK exists as `@stbr/solana-vault` (core) and `@stbr/svs-privacy-sdk` (privacy) but only covers basic vault operations — the module/plugin architecture from the original plan has not been implemented yet.

---

## The Four Standards

```
CORE (Deployed to Devnet)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  SVS-1 — Live Balance Vault
    Assets stay in vault ATA. Share price = balance / supply.
    No sync, no trust assumption, lowest complexity.
    Use: lending pools, liquid staking, simple yield.

  SVS-2 — Stored Balance Vault (+ sync)
    Assets deployed elsewhere. Manager reports total_assets via sync().
    Trust assumption on sync caller.
    Use: yield aggregators, strategy vaults, fund managers.

ALPHA (Programs Written, Not Deployed)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  SVS-3 — Private Live Balance Vault
    SVS-1 + Token-2022 Confidential Transfers for share balances.
    Use: private DeFi positions.

  SVS-4 — Private Stored Balance Vault
    SVS-2 + Token-2022 Confidential Transfers.
    Use: private strategy vaults, institutional funds.
```

---

## Completed Work

### Phase 1: SVS-1 Foundation
- [x] `anchor build` clean
- [x] `cargo fmt && cargo clippy` passes
- [x] All SVS-1 integration tests green (~19 tests)
- [x] Math uses u128 intermediates in all convert functions
- [x] Rounding direction verified in every instruction
- [x] Security pass: account validation, no unwrap(), checked arithmetic, stored bumps
- [x] Virtual offset inflation attack protection
- [x] Deploy SVS-1 to devnet (`Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC`)

### Phase 2: SVS-2 Sync
- [x] SVS-2 tests green (~30 tests)
- [x] Donation -> sync() -> share price increase tested
- [x] Multi-user yield distribution tested
- [x] Sync timing attack mitigated by virtual offset
- [x] Deploy SVS-2 to devnet (`3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD`)

### Shared Test Suites (SVS-1 + SVS-2)
- [x] Edge cases (~15 tests)
- [x] Multi-user scenarios (~15 tests)
- [x] Decimal handling (~12 tests)
- [x] Yield/sync (~12 tests)
- [x] Mathematical invariants (~15 tests)
- [x] Admin operations (~10 tests)
- [x] Full lifecycle (~8 tests)
- [x] SDK unit tests (113 tests: math, PDA, vault, errors, events)

### SDK Core
- [x] `SolanaVault` class with deposit/mint/withdraw/redeem
- [x] Off-chain math (previewDeposit/Mint/Withdraw/Redeem, convertToShares/Assets)
- [x] PDA derivation helpers
- [x] Auto-detection of SPL Token vs Token-2022 for asset mints
- [x] `sync()` method for SVS-2

### SVS-3/SVS-4 Programs
- [x] Programs written with ConfidentialTransfer extension
- [x] configure_account, apply_pending instructions
- [x] ZK proof context account validation (owner == zk_elgamal_proof_program)
- [x] Proof backend service scaffolded (proofs-backend/)

### Privacy SDK
- [x] Key derivation (ElGamal, AES)
- [x] Instruction builders for CT operations
- [x] ZK proof discriminators and instruction wrappers
- [x] Placeholder proof generation (real proofs require Rust backend or WASM)

---

## Remaining Work

### Phase 3: SDK — `@stbr/solana-vault`

The current SDK covers basic operations. The planned module/plugin architecture has not been built.

#### 3.1 SDK Restructure

Rename and reorganize:

```
sdk/core/
├── src/
│   ├── index.ts              # Public exports
│   ├── vault.ts              # SolanaVault (SVS-1)
│   ├── managed-vault.ts      # ManagedVault (SVS-2, extends SolanaVault)
│   ├── math.ts
│   ├── pda.ts
│   ├── types.ts
│   └── cli.ts                # CLI entry point (solana-vault)
├── package.json              # @stbr/solana-vault + bin: solana-vault
└── tests/
```

**Known Issue**: `SolanaVault` exposes `sync()` unconditionally. Calling it on SVS-1 will fail at instruction level. Should either: (a) create a `ManagedVault` subclass that adds `sync()`, or (b) guard with a runtime check.

#### 3.2 CLI Tool (`solana-vault`)

Build a CLI binary for the SDK:
- `solana-vault create` — Initialize a new vault
- `solana-vault deposit` — Deposit assets
- `solana-vault redeem` — Redeem shares
- `solana-vault info` — Show vault state
- `solana-vault preview` — Preview operations

#### 3.3 SVS-3 SDK Incompatibility

The core SDK (`SolanaVault`) **will not work with SVS-3/SVS-4** because:

1. **Different account struct**: SVS-1/2 use `Vault`, SVS-3/4 use `ConfidentialVault`. The Anchor IDL generates different account names (`vault` vs `confidentialVault`), so `program.account["vault"].fetch()` fails on SVS-3.
2. **Different instruction signatures**: SVS-3 withdraw/redeem require `new_decryptable_available_balance` and proof context accounts. The core SDK's `withdraw()`/`redeem()` methods don't pass these.
3. **Different view function contexts**: SVS-3 `max_withdraw`/`max_redeem` use `VaultView` (returns vault-level bounds) instead of `VaultViewWithOwner` (returns user-specific bounds), because encrypted balances can't be read on-chain.

**Resolution options**:
- (a) Build a separate `ConfidentialVault` class in the privacy SDK that extends/wraps `SolanaVault`
- (b) Make `SolanaVault` generic over the account struct with a type parameter
- (c) Keep them fully separate — privacy SDK has its own vault class

#### 3.4 Module Architecture (Not Started)

Modules are SDK-level plugins that compose on top of base vault instructions:

| Module | Priority | Description |
|--------|----------|-------------|
| `fees` | P0 | Management + performance fee calculation |
| `cap` | P1 | Per-user and global deposit caps |
| `emergency` | P1 | Emergency withdrawal when paused (with penalty) |
| `access-control` | P1 | Whitelist/blacklist depositors |
| `multi-asset` | P2 | Meta-vault wrapping N single-asset vaults |
| `timelock` | P2 | Propose -> wait -> execute for admin ops |
| `strategy` | P3 | CPI templates for deploying to other protocols |

#### 3.5 Publish
- [ ] Build CLI (`solana-vault` binary)
- [ ] Separate `ManagedVault` from `SolanaVault`
- [ ] npm publish `@stbr/solana-vault`
- [ ] TypeDoc API documentation
- [ ] Examples folder

### Phase 4: SVS-3/SVS-4 (Alpha)

**Blocked by**: ZK proof generation requires Rust backend or WASM bindings (expected mid-2026).

- [ ] SVS-3 integration tests (requires proof infrastructure)
- [ ] SVS-4 integration tests
- [ ] `ConfidentialVault` SDK class (separate from `SolanaVault`)
- [ ] Proof backend -> SDK integration (REST API or direct WASM)
- [ ] Deploy SVS-3/4 to devnet once tests pass

### Phase 5: Documentation + Polish

- [ ] Per-variant spec docs (`docs/SVS-1.md`, `docs/SVS-2.md`)
- [ ] `docs/MODULES.md` — Module documentation with examples
- [ ] `docs/INTEGRATION.md` — How to build on SVS
- [ ] CI/CD: GitHub Actions (build -> fmt -> clippy -> test)
- [ ] AI slop cleanup pass on branch diff

### Phase 6: Production

- [ ] External security audit
- [ ] Trident fuzz 30+ minutes clean
- [ ] CU profiling (all instructions fit single tx)
- [ ] Verifiable build: `anchor build --verifiable`
- [ ] Multisig upgrade authority (Squads v4)
- [ ] Mainnet deployment (explicit user confirmation required)
- [ ] At least 1 integration partner building on SVS

---

## Key Technical Specs

### Virtual Offset (Inflation Attack Protection)
```
offset = 10^(9 - asset_decimals)
USDC (6 decimals) -> offset = 1,000
SOL (9 decimals)  -> offset = 1

shares = assets * (total_shares + offset) / (total_assets + 1)
assets = shares * (total_assets + 1) / (total_shares + offset)
```

### Rounding (Always Favors Vault)
| Operation | Direction | Effect |
|-----------|-----------|--------|
| deposit | Floor | User gets fewer shares |
| mint | Ceiling | User pays more assets |
| withdraw | Ceiling | User burns more shares |
| redeem | Floor | User receives fewer assets |

### PDA Seeds
| Account | Seeds | Notes |
|---------|-------|-------|
| Vault | `["vault", asset_mint, vault_id.to_le_bytes()]` | |
| Shares Mint | `["shares", vault_pubkey]` | |
| Asset Vault | `ATA(asset_mint, vault)` | Owned by vault PDA |

### Program IDs
| Program | Devnet | Localnet |
|---------|--------|----------|
| SVS-1 | `Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC` | `SVS1VauLt1111111111111111111111111111111111` |
| SVS-2 | `3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD` | `SVS2VauLt2222222222222222222222222222222222` |
| SVS-3 | Not deployed | `SVS3VauLt3333333333333333333333333333333333` |
| SVS-4 | Not deployed | `SVS4VauLt4444444444444444444444444444444444` |

### State Structs

**Vault (SVS-1, SVS-2) — 211 bytes:**
```rust
pub struct Vault {
    pub authority: Pubkey,       // 32
    pub asset_mint: Pubkey,      // 32
    pub shares_mint: Pubkey,     // 32
    pub asset_vault: Pubkey,     // 32
    pub total_assets: u64,       // 8  (unused in SVS-1, active in SVS-2)
    pub decimals_offset: u8,     // 1
    pub bump: u8,                // 1
    pub paused: bool,            // 1
    pub vault_id: u64,           // 8
    pub _reserved: [u8; 64],     // 64
}
```

**ConfidentialVault (SVS-3, SVS-4) — 254 bytes:**
```rust
pub struct ConfidentialVault {
    pub authority: Pubkey,                    // 32
    pub asset_mint: Pubkey,                   // 32
    pub shares_mint: Pubkey,                  // 32
    pub asset_vault: Pubkey,                  // 32
    pub total_assets: u64,                    // 8  (unused in SVS-3, active in SVS-4)
    pub decimals_offset: u8,                  // 1
    pub bump: u8,                             // 1
    pub paused: bool,                         // 1
    pub vault_id: u64,                        // 8
    pub auditor_elgamal_pubkey: Option<[u8; 32]>, // 33
    pub confidential_authority: Pubkey,       // 32
    pub _reserved: [u8; 32],                  // 32
}
```

---

## What's Explicitly Out of Scope (V1)

- **RWA vaults** — SVS-2 + access-control module is the foundation, but RWA-specific logic lives elsewhere.
- **On-chain fee logic** — Fees are SDK-level. Programs stay minimal.
- **On-chain access control** — SDK-enforced. Programs don't gate deposits by default.
- **Governance** — Authority is a single keypair (or multisig via Squads).
- **Cross-chain** — No bridging or cross-chain vault abstraction.
