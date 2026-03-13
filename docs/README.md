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
| [SVS-5](specs-SVS05.md) | Streaming Yield | Draft |
| [SVS-6](specs-SVS06.md) | Streaming + Confidential | Draft |
| [SVS-7](specs-SVS07.md) | Native SOL | Draft |
| [SVS-8](specs-SVS08.md) | Multi-Asset Basket | [Implemented](SVS-8.md) |
| [SVS-9](specs-SVS09.md) | Allocator (Vault-of-Vaults) | Draft |
| [SVS-10](specs-SVS10.md) | Async (ERC-7540) | Draft |
| [SVS-11](specs-SVS11.md) | Credit Markets | Draft |
| [SVS-12](specs-SVS12.md) | Tranched (Structured) | Draft |

---

## Module System

Optional on-chain modules for additional functionality:

| Module | Purpose | Spec |
|--------|---------|------|
| svs-fees | Entry/exit/management/performance fees | [specs-modules.md](specs-modules.md#31-svs-fees) |
| svs-caps | Global and per-user deposit caps | [specs-modules.md](specs-modules.md#32-svs-caps) |
| svs-locks | Time-locked shares | [specs-modules.md](specs-modules.md#33-svs-locks) |
| svs-rewards | Secondary reward token distribution | [specs-modules.md](specs-modules.md#34-svs-rewards) |
| svs-access | Whitelist/blacklist/freeze | [specs-modules.md](specs-modules.md#35-svs-access) |
| svs-oracle | Shared oracle price interface | [specs-modules.md](specs-modules.md#36-svs-oracle) |

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
