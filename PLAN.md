# Solana Vault Standard (SVS) — Implementation Plan

## Status

Phases 1-2 complete. Programs built, tested, deployed to devnet. Proof backend functional. SDK needs restructure and CLI is built.

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
    Proof backend ready (Rust/Axum, 3 endpoints, 16 tests).
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

### SDK Core (`@stbr/solana-vault`)
- [x] `SolanaVault` class with deposit/mint/withdraw/redeem (SVS-1)
- [x] `ManagedVault` subclass with `sync()` and `storedTotalAssets()` (SVS-2)
- [x] Off-chain math (previewDeposit/Mint/Withdraw/Redeem, convertToShares/Assets)
- [x] PDA derivation helpers
- [x] Auto-detection of SPL Token vs Token-2022 for asset mints
- [x] CLI tool (`solana-vault` binary with info/preview/convert/derive)

### SVS-3/SVS-4 Programs
- [x] Programs written with ConfidentialTransfer extension
- [x] configure_account, apply_pending instructions
- [x] ZK proof context account validation (owner == zk_elgamal_proof_program)
- [x] SVS-3 integration tests (29 tests: init, admin, views, CT deposit flow)
- [x] SVS-4 integration tests (30 tests: init, admin, views, sync, CT deposit+sync flow)
- [x] Test proof client helper (`tests/helpers/proof-client.ts`)
- [x] Program IDs updated from vanity to real keypairs
- [x] Full test suite: 95 passing across all 4 programs (+ 13 backend-dependent skippable)

### Proof Backend (`proofs-backend/`)
- [x] Axum REST API with 3 proof endpoints + health check
- [x] PubkeyValidityProof generation (64 bytes, for ConfigureAccount)
- [x] CiphertextCommitmentEqualityProof generation (192 bytes, for Withdraw/Redeem)
- [x] BatchedRangeProofU64 generation (672+ bytes, for range validation)
- [x] Dual-layer auth (API key + Ed25519 wallet signature verification)
- [x] Replay attack prevention (5-min timestamp window)
- [x] 16 unit tests passing
- [x] Docker deployment ready (Dockerfile + docker-compose.yml)
- [x] Uses solana-zk-sdk 2.1 (latest stable)

### Privacy SDK (`@stbr/svs-privacy-sdk`)
- [x] Key derivation (ElGamal, AES)
- [x] Instruction builders for CT operations
- [x] ZK proof discriminators and instruction wrappers
- [x] Backend client integration (`configureProofBackend()`, `createPubkeyValidityProofViaBackend()`, etc.)
- [x] Placeholder proof functions (for environments without backend)

---

## Remaining Work

### Phase 3: SDK Restructure — `@stbr/solana-vault`

#### 3.1 ManagedVault Separation ✅

Done. `SolanaVault` is SVS-1 only (no `sync()`). `ManagedVault` extends it with `sync()` and `storedTotalAssets()` for SVS-2.

```
sdk/core/src/
├── vault.ts              # SolanaVault (SVS-1) — no sync()
├── managed-vault.ts      # ManagedVault (SVS-2) — extends SolanaVault, adds sync()
├── math.ts
├── pda.ts
├── cli.ts                # solana-vault CLI
└── index.ts              # Exports both classes
```

#### 3.2 SVS-3 SDK — ConfidentialSolanaVault ✅

Done. Lives in privacy SDK (`@stbr/svs-privacy-sdk`). The core SDK **does not work** with SVS-3/SVS-4 because of different account struct (`ConfidentialVault` vs `Vault`), different instruction signatures (proof context accounts), and different view function contexts.

`ConfidentialSolanaVault` in `sdk/privacy/src/confidential-vault.ts` wraps SVS-3 directly with configureAccount, deposit, applyPending, withdraw, redeem, and view functions.

#### 3.3 Module Architecture (Not Started)

| Module | Priority | Description |
|--------|----------|-------------|
| `fees` | P0 | Management + performance fee calculation |
| `cap` | P1 | Per-user and global deposit caps |
| `emergency` | P1 | Emergency withdrawal when paused (with penalty) |
| `access-control` | P1 | Whitelist/blacklist depositors |
| `multi-asset` | P2 | Meta-vault wrapping N single-asset vaults |
| `timelock` | P2 | Propose -> wait -> execute for admin ops |
| `strategy` | P3 | CPI templates for deploying to other protocols |

#### 3.4 Publish
- [x] CLI (`solana-vault` binary)
- [x] Separate `ManagedVault` from `SolanaVault`
- [x] `ConfidentialSolanaVault` class in privacy SDK
- [ ] npm publish `@stbr/solana-vault`
- [ ] TypeDoc API documentation
- [ ] Examples folder

### Phase 4: SVS-3/SVS-4 Testing & Deployment

**Not blocked.** Proof backend is production-ready. SDK client integration exists. What's missing is integration tests and devnet deployment.

#### 4.1 SVS-3 Integration Tests
Start backend (`cargo run` or `docker compose up`), write tests exercising:
- [x] Initialize vault with ConfidentialTransferMint extension
- [x] ConfigureAccount with PubkeyValidityProof via backend
- [x] Deposit -> shares arrive as pending balance
- [x] ApplyPending -> move to available balance
- [ ] Withdraw with EqualityProof + RangeProof via backend
- [ ] Redeem with EqualityProof + RangeProof via backend
- [x] Pause/unpause with confidential state
- [x] View functions return correct vault-level bounds

#### 4.2 SVS-4 Integration Tests ✅
Same as SVS-3 plus:
- [x] sync() updates total_assets
- [x] Operations use stored balance correctly
- [x] External donation doesn't change stored balance
- [x] sync() increases share price for existing holders
- [x] Second deposit gets fewer shares after sync

#### 4.3 Deploy
- [ ] Deploy SVS-3 to devnet
- [ ] Deploy SVS-4 to devnet

### Phase 5: Documentation

Should happen alongside Phases 3-4, not after.

#### Per-Variant Spec Docs
- [x] `docs/SVS-1.md` — Live balance vault spec: accounts, instructions, math, use cases, deployment info
- [x] `docs/SVS-2.md` — Stored balance + sync spec: sync mechanics, trust model, yield strategies
- [x] `docs/SVS-3.md` — Confidential live balance spec: CT extension, proof flow, configure_account/apply_pending, backend integration, view function differences
- [x] `docs/SVS-4.md` — Confidential stored balance spec: SVS-3 + sync

#### Other Docs
- [ ] `docs/MODULES.md` — Module documentation with examples (when modules built)
- [ ] `docs/INTEGRATION.md` — How to build on SVS
- [ ] `docs/PROOF-BACKEND.md` — Deployment guide, API reference, security model (backend has its own README but needs cross-linking)

#### Infrastructure
- [ ] CI/CD: GitHub Actions (build -> fmt -> clippy -> test -> backend test)
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
| SVS-1 | `Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC` | Same as devnet |
| SVS-2 | `3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD` | Same as devnet |
| SVS-3 | Not deployed | `EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh` |
| SVS-4 | Not deployed | `2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY` |

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

### Proof Backend
| Endpoint | Proof | Size | Use Case |
|----------|-------|------|----------|
| `POST /api/proofs/pubkey-validity` | PubkeyValidityProof | 64 B | ConfigureAccount |
| `POST /api/proofs/equality` | CiphertextCommitmentEqualityProof | 192 B | Withdraw/Redeem |
| `POST /api/proofs/range` | BatchedRangeProofU64 | 672+ B | Range validation |

Security: dual-layer auth (API key + Ed25519 signature), 5-min replay window, 64KB body limit.

---

## What's Explicitly Out of Scope (V1)

- **RWA vaults** — SVS-2 + access-control module is the foundation, but RWA-specific logic lives elsewhere.
- **On-chain fee logic** — Fees are SDK-level. Programs stay minimal.
- **On-chain access control** — SDK-enforced. Programs don't gate deposits by default.
- **Governance** — Authority is a single keypair (or multisig via Squads).
- **Cross-chain** — No bridging or cross-chain vault abstraction.
