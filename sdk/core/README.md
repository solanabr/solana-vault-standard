# @stbr/solana-vault

Core TypeScript SDK for the Solana Vault Standard (SVS). ERC-4626 compatible tokenized vault interface for Solana.

## Installation

```bash
npm install @stbr/solana-vault
```

## Quick Start

```typescript
import { SolanaVault, ManagedVault } from "@stbr/solana-vault";
import { BN } from "@coral-xyz/anchor";

// Load vault
const vault = await SolanaVault.load(program, assetMint, vaultId);

// Preview and deposit
const expectedShares = await vault.previewDeposit(new BN(1_000_000));
await vault.deposit(user, {
  assets: new BN(1_000_000),
  minSharesOut: expectedShares.mul(new BN(95)).div(new BN(100)),
});

// Redeem shares
const expectedAssets = await vault.previewRedeem(shares);
await vault.redeem(user, {
  shares,
  minAssetsOut: expectedAssets.mul(new BN(95)).div(new BN(100)),
});
```

## Features

- **ERC-4626 Compatible** - Standard vault interface
- **Inflation Attack Protection** - Virtual offset mechanism
- **Vault-Favoring Rounding** - Protects solvency
- **Slippage Protection** - Min/max parameters
- **Multi-Vault Support** - Multiple vaults per asset

## SDK Modules

```typescript
export * from "./vault";          // Core vault operations
export * from "./math";           // ERC-4626 math utilities
export * from "./fees";           // Fee calculation (management, performance)
export * from "./cap";            // Deposit caps (global, per-user)
export * from "./emergency";      // Emergency withdrawal with penalty
export * from "./access-control"; // Whitelist/blacklist + merkle proofs
export * from "./multi-asset";    // Multi-vault portfolio allocation
export * from "./timelock";       // Governance proposal lifecycle
export * from "./strategy";       // CPI templates for protocol deployment
```

## Documentation

See [SDK Documentation](https://github.com/solanabr/tokenized-vault-standard/blob/main/docs/SDK.md).

## License

Apache 2.0
