# Solana Vault Standard (SVS) — Implementation Plan

## Status

Phases 1-4 complete. All 4 programs built, tested (114 tests), deployed to devnet. Proof backend functional (19 tests). SDK and CLI built.

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

BETA (Deployed to Devnet)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  SVS-3 — Private Live Balance Vault
    SVS-1 + Token-2022 Confidential Transfers for share balances.
    Proof backend ready (Rust/Axum, 4 endpoints, 19 tests).
    Use: private DeFi positions.

  SVS-4 — Private Stored Balance Vault
    SVS-2 + Token-2022 Confidential Transfers.
    Use: private strategy vaults, institutional funds.
```

---

## Remaining Work

### SDK Publish

- [ ] npm publish `@stbr/solana-vault`
- [ ] TypeDoc API documentation
- [ ] Examples folder

### Module Architecture

| Module | Priority | Description |
|--------|----------|-------------|
| `fees` | P0 | Management + performance fee calculation |
| `cap` | P1 | Per-user and global deposit caps |
| `emergency` | P1 | Emergency withdrawal when paused (with penalty) |
| `access-control` | P1 | Whitelist/blacklist depositors |
| `multi-asset` | P2 | Meta-vault wrapping N single-asset vaults |
| `timelock` | P2 | Propose -> wait -> execute for admin ops |
| `strategy` | P3 | CPI templates for deploying to other protocols |

### Documentation

- [ ] `docs/MODULES.md` — Module documentation with examples (when modules built)
- [ ] `docs/INTEGRATION.md` — How to build on SVS
- [ ] `docs/PROOF-BACKEND.md` — Deployment guide, API reference, security model

### Infrastructure

- [ ] CI/CD: GitHub Actions (build -> fmt -> clippy -> test -> backend test)

### Production

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
| SVS-3 | `EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh` | Same as devnet |
| SVS-4 | `2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY` | Same as devnet |

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
| `POST /api/proofs/withdraw` | Equality + Range (shared opening) | 320 + 936 B | Withdraw/Redeem (combined) |

Security: dual-layer auth (API key + Ed25519 signature), 5-min replay window, 64KB body limit.

---

## Out of Scope (V1)

- **RWA vaults** — SVS-2 + access-control module is the foundation, but RWA-specific logic lives elsewhere.
- **On-chain fee logic** — Fees are SDK-level. Programs stay minimal.
- **On-chain access control** — SDK-enforced. Programs don't gate deposits by default.
- **Governance** — Authority is a single keypair (or multisig via Squads).
- **Cross-chain** — No bridging or cross-chain vault abstraction.
