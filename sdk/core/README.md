# @stbr/solana-vault

[![npm version](https://img.shields.io/npm/v/@stbr/solana-vault.svg)](https://www.npmjs.com/package/@stbr/solana-vault)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

TypeScript SDK and CLI for the Solana Vault Standard (SVS). Build yield-bearing vaults with deposit/withdraw operations, share accounting, preview functions, and modular extensions.

## Features

- **Core Vault Operations** - Deposit, mint, withdraw, redeem with slippage protection
- **Preview Functions** - Off-chain calculation of expected shares/assets
- **Inflation Attack Protection** - Virtual offset mechanism prevents donation attacks
- **Vault-Favoring Rounding** - All operations round to protect vault solvency
- **Multi-Vault Support** - Multiple vaults per asset via `vault_id`
- **CLI Tool** - Full-featured command-line interface for vault management
- **Modular Extensions** - Fees, caps, access control, timelocks, strategies

## Installation

```bash
npm install @stbr/solana-vault
```

## Quick Start

### SDK Usage

```typescript
import { SolanaVault, ManagedVault } from "@stbr/solana-vault";
import { BN } from "@coral-xyz/anchor";

// Load an SVS-1 vault (live balance)
const vault = await SolanaVault.load(program, assetMint, 1);

// Preview deposit to calculate expected shares
const expectedShares = await vault.previewDeposit(new BN(1_000_000));

// Deposit with 5% slippage protection
await vault.deposit(user, {
  assets: new BN(1_000_000),
  minSharesOut: expectedShares.mul(new BN(95)).div(new BN(100)),
});

// Preview and redeem shares
const expectedAssets = await vault.previewRedeem(shares);
await vault.redeem(user, {
  shares,
  minAssetsOut: expectedAssets.mul(new BN(95)).div(new BN(100)),
});

// SVS-2 vaults: use ManagedVault for sync() support
const managed = await ManagedVault.load(program, assetMint, 1);
await managed.sync(authority); // Sync stored balance with actual
```

### CLI Usage

```bash
# Install globally
npm install -g @stbr/solana-vault

# Initialize configuration
solana-vault config init

# Add a vault alias
solana-vault config add-vault my-vault <ADDRESS> --variant svs-1

# Common operations
solana-vault info my-vault           # View vault state
solana-vault balance my-vault        # Check your balance
solana-vault preview my-vault deposit 1000000  # Preview deposit
solana-vault deposit my-vault -a 1000000       # Deposit assets
solana-vault redeem my-vault --all   # Redeem all shares
solana-vault dashboard my-vault      # Live monitoring
```

## SDK Modules

```typescript
// Core vault operations
export { SolanaVault } from "./vault";
export { ManagedVault } from "./managed-vault";

// Share/asset conversion math
export { convertToShares, convertToAssets, Rounding } from "./math";

// PDA derivation utilities
export { getVaultAddress, getSharesMintAddress } from "./pda";

// Extension modules
export * from "./fees";           // Management, performance, entry/exit fees
export * from "./cap";            // Global and per-user deposit caps
export * from "./emergency";      // Emergency withdrawal with penalty
export * from "./access-control"; // Whitelist/blacklist + merkle proofs
export * from "./multi-asset";    // Multi-vault portfolio allocation
export * from "./timelock";       // Governance proposal lifecycle
export * from "./strategy";       // DeFi strategy deployment
```

## Core Operations

| Operation | User Action | Slippage Param | Rounding |
|-----------|-------------|----------------|----------|
| `deposit` | Pay exact assets → receive shares | `minSharesOut` | Floor (fewer shares) |
| `mint` | Receive exact shares → pay assets | `maxAssetsIn` | Ceiling (pay more) |
| `withdraw` | Receive exact assets → burn shares | `maxSharesIn` | Ceiling (burn more) |
| `redeem` | Burn exact shares → receive assets | `minAssetsOut` | Floor (receive less) |

## CLI Commands

### Inspect
- `info <vault>` - Display vault state
- `balance <vault>` - Check user balance
- `preview <vault> <op> <amount>` - Preview operations
- `list` - List configured vaults
- `history <vault>` - Transaction history

### Operate
- `deposit <vault> -a <amount>` - Deposit assets
- `mint <vault> --shares <amount>` - Mint exact shares
- `withdraw <vault> -a <amount>` - Withdraw exact assets
- `redeem <vault> --shares <amount>` - Redeem shares

### Admin
- `pause <vault>` - Emergency pause
- `unpause <vault>` - Resume operations
- `sync <vault>` - Sync balance (SVS-2/4)
- `transfer-authority <vault>` - Transfer ownership

### Extensions
- `fees show|configure|collect` - Fee management
- `cap show|configure|check` - Deposit caps
- `access show|set-mode|add|remove` - Access control
- `emergency show|configure|withdraw` - Emergency withdrawal
- `timelock show|propose|execute|cancel` - Timelocked governance
- `strategy show|add|deploy|recall` - DeFi strategies
- `portfolio show|deposit|redeem|rebalance` - Multi-vault portfolios
- `ct configure|apply-pending|status` - Confidential transfers (SVS-3/4)

### Monitoring
- `dashboard <vault>` - Real-time monitoring
- `health <vault>` - Comprehensive health check

**Global flags:** `--dry-run`, `--yes`, `--output json|table|csv`, `--keypair <path>`, `--url <rpc>`

## View Functions

All view functions work off-chain (no transactions required):

```typescript
// Get vault state
const state = await vault.getState();

// Total assets and shares
const totalAssets = await vault.totalAssets();
const totalShares = await vault.totalShares();

// Convert between assets and shares
const shares = await vault.convertToShares(assets);
const assets = await vault.convertToAssets(shares);

// Preview operations
const sharesOut = await vault.previewDeposit(assets);
const assetsIn = await vault.previewMint(shares);
const sharesIn = await vault.previewWithdraw(assets);
const assetsOut = await vault.previewRedeem(shares);

// Admin functions
const isPaused = await vault.isPaused();
const authority = await vault.getAuthority();
```

## PDA Derivation

```typescript
import { getVaultAddress, getSharesMintAddress } from "@stbr/solana-vault";

// Vault PDA: ["vault", asset_mint, vault_id.to_le_bytes()]
const [vaultPda, bump] = getVaultAddress(programId, assetMint, vaultId);

// Shares Mint PDA: ["shares", vault_pubkey]
const [sharesMint, mintBump] = getSharesMintAddress(programId, vaultPda);
```

## Error Handling

```typescript
import { parseVaultError, isSlippageError, VaultErrorCode } from "@stbr/solana-vault";

try {
  await vault.deposit(user, params);
} catch (error) {
  const parsed = parseVaultError(error);
  if (parsed) {
    switch (parsed.code) {
      case VaultErrorCode.SlippageExceeded:
        console.error("Slippage tolerance exceeded");
        break;
      case VaultErrorCode.VaultPaused:
        console.error("Vault is paused");
        break;
      case VaultErrorCode.InsufficientShares:
        console.error("Not enough shares");
        break;
    }
  }
}
```

## Slippage Protection

Always use slippage protection to guard against MEV:

```typescript
// Helper function
function applySlippage(amount: BN, bps: number, isReceiving: boolean): BN {
  const basis = new BN(10000);
  const slippage = new BN(bps);
  return isReceiving
    ? amount.mul(basis.sub(slippage)).div(basis)  // Accept less
    : amount.mul(basis.add(slippage)).div(basis); // Pay more
}

// Usage (50 bps = 0.5% slippage)
const minShares = applySlippage(expectedShares, 50, true);
const maxAssets = applySlippage(requiredAssets, 50, false);
```

## SVS Variants

| Variant | Balance Model | Privacy | Use Case |
|---------|---------------|---------|----------|
| SVS-1 | Live (reads actual balance) | Public | Simple vaults, lending |
| SVS-2 | Stored (cached, needs sync) | Public | Yield aggregators, managed funds |
| SVS-3 | Live | Confidential | Private savings |
| SVS-4 | Stored | Confidential | Private managed funds |

**Note:** SVS-3/SVS-4 require the `@stbr/svs-privacy-sdk` package and a proof backend.

## Configuration

The CLI stores config in `~/.solana-vault/config.yaml`:

```yaml
defaults:
  cluster: devnet
  keypair: ~/.config/solana/id.json
  output: table

vaults:
  my-vault:
    address: "7xKYqBvpmmN..."
    variant: svs-1
    assetMint: "EPjFWdd5Aufq..."
```

## Requirements

- Node.js 20+
- Solana CLI (for keypair management)
- SVS program deployed (devnet IDs in main README)

## Documentation

- [Full SDK Documentation](https://github.com/solanabr/solana-vault-standard/blob/main/docs/SDK.md)
- [CLI Reference](https://github.com/solanabr/solana-vault-standard/blob/main/docs/CLI.md)
- [Architecture](https://github.com/solanabr/solana-vault-standard/blob/main/docs/ARCHITECTURE.md)
- [Security](https://github.com/solanabr/solana-vault-standard/blob/main/docs/SECURITY.md)

## License

Apache 2.0
