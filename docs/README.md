# Solana Vault Standard (SVS) Documentation

Native Solana port of ERC-4626 tokenized vault standard. Provides standardized interfaces for tokenized vaults with shares representing proportional ownership of underlying SPL tokens.

---

## Quick Start

```typescript
import { SolanaVault } from '@stbr/solana-vault';

const vault = await SolanaVault.load(provider, vaultPubkey);

// Deposit assets, receive shares
await vault.deposit(1_000_000n, 0n);

// Redeem shares for assets
const shares = await vault.getShareBalance(user.publicKey);
await vault.redeem(shares, 0n);
```

---

## Core Variants

Four program variants cover public/private and live/stored balance models:

| Variant | Balance | Privacy | Use Case |
|---------|---------|---------|----------|
| [**SVS-1**](SVS-1.md) | Live | Public | Simple vaults, lending pools |
| [**SVS-2**](SVS-2.md) | Stored | Public | Strategy vaults, deployed capital |
| [**SVS-3**](SVS-3.md) | Live | Confidential | Private yield farming |
| [**SVS-4**](SVS-4.md) | Stored | Confidential | Institutional private funds |

**Decision Guide**:
- Assets stay in vault → **SVS-1**
- Assets deployed externally → **SVS-2**
- Need privacy → **SVS-3** or **SVS-4**

---

## Extended Variants

| Variant | Purpose | Status |
|---------|---------|--------|
| [SVS-5](SVS-5.md) | Streaming Yield | Implemented |
| [SVS-6](SVS-6.md) | Streaming + Confidential | Implemented |
| [SVS-7](SVS-7.md) | Native SOL | Implemented |
| [SVS-8](SVS-8.md) | Multi-Asset Basket | Implemented |
| [SVS-9](SVS-9.md) | Allocator (Vault-of-Vaults) | Implemented |
| [SVS-10](SVS-10.md) | Async (ERC-7540) | Implemented |
| [SVS-11](SVS-11.md) | Credit Markets | Devnet |
| [SVS-12](SVS-12.md) | Tranched (Structured) | Devnet |

---

## Module System

Optional on-chain modules for additional functionality:

| Module | Purpose | Spec |
|--------|---------|------|
| svs-fees | Entry/exit/management/performance fees | [MODULES.md](MODULES.md#svs-fees) |
| svs-caps | Global and per-user deposit caps | [MODULES.md](MODULES.md#svs-caps) |
| svs-locks | Time-locked shares | [MODULES.md](MODULES.md#svs-locks) |
| svs-rewards | Secondary reward token distribution | [MODULES.md](MODULES.md#svs-rewards) |
| svs-access | Whitelist/blacklist/freeze | [MODULES.md](MODULES.md#svs-access) |
| svs-oracle | Shared oracle price interface | [MODULES.md](MODULES.md#svs-oracle) |
| svs-attestation | Shared KYC/KYB attestation interface | [MODULES.md](MODULES.md#svs-attestation) |

---

## Credit Markets Programs

Supporting programs for the SVS-11 institutional-credit primitive:

| Program | Purpose | Doc |
|---------|---------|-----|
| compliance-hook | Token-2022 `TransferHook` backend (FreelyTransferable/Permissioned) + sanctions & freeze | [compliance-hook.md](compliance-hook.md) |
| nav-oracle | Per-pool signed NAV oracle (reference `svs-oracle` implementation) | [nav-oracle.md](nav-oracle.md) |
| derwa-wrapper | 1:1 permissioned-cPOOL ↔ tradeable-dePOOL bridge, attestation-gated unwrap | [derwa-wrapper.md](derwa-wrapper.md) |

---

## Architecture & Design

| Document | Description |
|----------|-------------|
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | Cross-variant design, balance models, math |
| [**PATTERNS.md**](PATTERNS.md) | Implementation patterns for contributors |
| [**ERC-4626-REFERENCE.md**](ERC-4626-REFERENCE.md) | EVM mapping and reference implementations |

---

## Reference

| Document | Description |
|----------|-------------|
| [**ERRORS.md**](ERRORS.md) | Error codes (6000+) |
| [**CONSTANTS.md**](CONSTANTS.md) | PDA seeds, numeric limits |
| [**EVENTS.md**](EVENTS.md) | Event definitions and parsing |

---

## Security

| Document | Description |
|----------|-------------|
| [**SECURITY.md**](SECURITY.md) | Security model, attack vectors, checklists |
| [**PRIVACY.md**](PRIVACY.md) | Confidential transfer details (SVS-3/4) |

---

## Operations

| Document | Description |
|----------|-------------|
| [**TESTING.md**](TESTING.md) | Testing strategy, 735+ test cases |
| [**DEPLOYMENT.md**](DEPLOYMENT.md) | Deployment procedures |
| [**SDK.md**](SDK.md) | TypeScript SDK usage |
| [**CLI.md**](CLI.md) | Command-line interface |

---

## Program IDs

### Devnet

| Program | ID |
|---------|-----|
| SVS-1 | `CzZyssz2PdLccWpbVi6a3wFKMmMqdf28U2RapNNRJSPX` |
| SVS-2 | `7vnZM4aCsRapH9ft7Bo5ibTXNH2dvoxkj96c7JonLhoe` |
| SVS-3 | `CC4xQGxmwKusLW3ToqUzRAFjh7cL2iKsgfkz6qJSasYs` |
| SVS-4 | `EqRNvMTwczQjUhQL8wwrxJGALgz5VWsYne3d67e6ruCv` |
| SVS-5 | `HCp23XHzV4HJHXwLWwQj8aSTU1yjyzj8FCNLe6NybwXt` |
| SVS-6 | `oaT6wgNiwCqd7EGvB6Wb5ZFYUJXckk6LEhB7MWqXbyC` |
| SVS-7 | `CR2ccVacmbQ2DaXvR66W7gnmH7KuDCqbVW5VwnTczQUC` |
| SVS-8 | `HnZ9N8Y1v6jMhwDqo4Y76GfqjRArdinadgK67yLVFZbe` |
| SVS-9 | `AaADS3DCGkjhDEDbGkygbG9bNaziR9TPK2X7SMBYedws` |
| SVS-10 | `4G5d6KutMpUaDPTVcv7FJBpPTGZej8rx3GyGnfiRdD6M` |
| SVS-11 | `CMeQ5Lx7AvjuW3DrzNvEkPZSdqKZjjhaTrAmgqBvPKHD` |
| SVS-12 | `EPwH58e5V1UXYkkD8JZ4bq7Wr2iRiC9fLj1S6BRRz2R` |

### Mainnet

Not deployed (pending audit).

---

## Stack

- **Programs**: Anchor 0.31+, Rust 1.82+
- **Token Standard**: Token-2022 (shares), SPL Token or Token-2022 (assets)
- **SDK**: TypeScript, `@coral-xyz/anchor`
- **Reference**: [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626)

---

## Contributing

1. Read [PATTERNS.md](PATTERNS.md) for implementation conventions
2. Review [SECURITY.md](SECURITY.md) for security requirements
3. Follow branch naming: `<type>/<scope>-<description>`
4. Run tests before commit: `anchor test`
5. See [CLAUDE.md](../CLAUDE.md) for AI-assisted development guidelines

---

## License

See repository root for license information.
