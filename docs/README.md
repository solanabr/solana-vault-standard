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
| SVS-1 | `Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC` |
| SVS-2 | `3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD` |
| SVS-3 | `EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh` |
| SVS-4 | `2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY` |
| SVS-5 | `3XQX3ZKGcy618XyWMmQiukYohJNSh3JNWoffq8ZeFdcS` |
| SVS-6 | `2w7aL5ZrD2i9RpzQBGSPAg7s61wVc8Qs8gtuQUTojEDE` |
| SVS-7 | `6v6FHxx26oqjJEjZa3S2XiuWSuDbYScd9VB7kLa4yzmE` |
| SVS-8 | `E8bGqwitsaFELBtuhbwAKwVBKjAjGzrfcnBPishvvRsA` |
| SVS-9 | `CZweMiLWPPgKMiQXVNSuuwaoiHUyKWZzoBhhFg2D1VaU` |
| SVS-10 | `CpjFjyxRwTGYxR6JWXpfQ1923z5wVwpyBvgPFjm9jamJ` |
| SVS-11 | `Bf17gDR2JdKTWdoTWK3Va9YQtkpePRAAVxMCaokj8ZFW` |
| SVS-12 | `FM3ZfmPSdQzFniZSDXc6FfXKFvXRSNQXeTdPKC8tz5C` |

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
