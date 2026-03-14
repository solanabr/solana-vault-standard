# Solana Vault Standard (SVS)

Tokenized vault programs and TypeScript SDK for building yield-bearing vaults on Solana. The SDK provides deposit/withdraw operations, share accounting, preview functions, and modular extensions for fees, caps, access control, timelocks, and multi-asset portfolios. The interface follows the ERC-4626 specification adapted for Solana's account model.

## SVS Variants

| Version | Name | Balance Model | Privacy | Sync | Status |
|---------|------|---------------|---------|------|--------|
| **SVS-1** | Public Vault (Live) | Live balance | None | No sync needed | Devnet |
| **SVS-2** | Public Vault (Stored) | Stored balance | None | Requires sync() | Devnet |
| **SVS-3** | Private Vault (Live) | Live balance | Encrypted | No sync needed | Devnet |
| **SVS-4** | Private Vault (Stored) | Stored balance | Encrypted | Requires sync() | Devnet |
| **SVS-8** | Multi-Asset Basket | Multi-asset | None | No sync needed | Devnet |

### Balance Model Comparison

**Live Balance (SVS-1, SVS-3, SVS-8):**
- Uses asset_vault.amount directly for all calculations
- External donations/yield immediately reflected in share price
- No sync timing attack vulnerability
- No sync() function needed

**Stored Balance (SVS-2, SVS-4):**
- Uses vault.total_assets stored in account
- Requires sync() call to recognize external donations
- Authority controls when yield is recognized
- May be preferred for yield strategies that require controlled distribution

### Privacy Model

**Public (SVS-1, SVS-2, SVS-8):**
- Token-2022 shares mint (no extensions)
- All balances visible on-chain
- Simple, auditable, production-ready

**Private (SVS-3, SVS-4):**
- Token-2022 with Confidential Transfers extension
- Share balances encrypted with ElGamal
- Only owner can decrypt their balance
- Requires Rust proof backend for ZK proof generation

## Program IDs

| Program | Devnet | Localnet |
|---------|--------|----------|
| SVS-1 | Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC | Same as devnet |
| SVS-2 | 3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD | Same as devnet |
| SVS-3 | EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh | Same as devnet |
| SVS-4 | 2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY | Same as devnet |
| SVS-8 | SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j | Same as devnet |

## Installation

```bash
# Core SDK (SVS-1/SVS-2)
npm install @stbr/solana-vault

# Privacy SDK (SVS-3/SVS-4)
npm install @stbr/svs-privacy-sdk

# Backend (for private vault proof generation)
cd proofs-backend && cargo run
```

## Quick Start

```typescript
import { SolanaVault, ManagedVault } from "@stbr/solana-vault";
import { BasketVault } from "@stbr/solana-vault/basket";
import { BN } from "@coral-xyz/anchor";

// SVS-1: Load live-balance vault
const vault = await SolanaVault.load(program, assetMint, 1);

// SVS-2: Load stored-balance vault (adds sync())
const managed = await ManagedVault.load(program, assetMint, 1);

// SVS-8: Load multi-asset basket vault
const basket = new BasketVault(program, programId);
await basket.depositSingle({
  vaultId: vaultId,
  assetMint: usdcMint,
  assetIndex: 0,
  amount: new BN(1_000_000),
  minSharesOut: new BN(0),
  userTokenAccount: userUsdc,
  userShareAccount: userShares,
  oracles: [pythUsdcFeed, pythSolFeed],
}, wallet);

// Preview deposit
const expectedShares = await vault.previewDeposit(new BN(1_000_000));

// Deposit with slippage protection
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

// SVS-2 only: sync stored balance
await managed.sync(authority);
```

## Features

| Feature | Description |
|---------|-------------|
| **Inflation Attack Protection** | Virtual offset mechanism prevents donation attacks |
| **Vault-Favoring Rounding** | All operations round to protect vault solvency |
| **Slippage Protection** | Min/max parameters prevent sandwich attacks |
| **Multi-Vault Support** | Multiple vaults per asset via vault_id |
| **Emergency Controls** | Pause/unpause and authority transfer |
| **CPI-Composable Views** | Preview functions callable from other programs |
| **Multi-Asset Basket (SVS-8)** | Up to 8 assets, oracle-validated, rebalanceable |

## On-Chain Modules (SVS-1)

SVS-1 includes optional on-chain modules for enforcing vault policies at the program level. Build with --features modules to enable.

| Module | Description |
|--------|-------------|
| svs-fees | Entry/exit fees (max 10%), collected later via admin instruction |
| svs-caps | Global and per-user deposit caps with bypass prevention |
| svs-locks | Time-locked shares before redemption (max 1 year) |
| svs-access | Whitelist/blacklist with merkle proof verification |

Module PDAs are passed via remaining_accounts. If not passed, checks are skipped (backward compatible).

```bash
# Build SVS-1 with modules
anchor build -p svs-1 -- --features modules
```

## SDK Extensions

The TypeScript SDK includes modular extensions for common vault patterns:

| Module | Description |
|--------|-------------|
| fees | Management, performance, and entry/exit fee calculation |
| cap | Global and per-user deposit caps |
| emergency | Emergency withdrawal with configurable penalty |
| access-control | Whitelist/blacklist with merkle proof verification |
| multi-asset | Portfolio allocation across multiple vaults |
| timelock | Governance proposal lifecycle management |
| strategy | CPI templates for deploying assets to external protocols |
| basket-vault | SVS-8 multi-asset basket vault SDK (BasketVault class) |

## CLI

The SDK includes a CLI for vault management:

```bash
# Install globally
npm install -g @stbr/solana-vault

# Initialize config
solana-vault config init

# Add vault alias
solana-vault config add-vault my-vault <ADDRESS> --variant svs-1 --asset-mint <MINT>

# Common operations
solana-vault info my-vault          # View vault state
solana-vault balance my-vault       # Check your balance
solana-vault deposit my-vault -a 1000000   # Deposit assets
solana-vault withdraw my-vault -a 500000   # Withdraw assets
solana-vault dashboard my-vault     # Live monitoring

# SVS-8 Basket Vault operations
solana-vault basket init --vault-id <ID> --assets usdc,sol,bonk --weights 4000,4000,2000
solana-vault basket deposit-single --vault-id <ID> --asset usdc --amount 1000000
solana-vault basket deposit-proportional --vault-id <ID> --shares 1000000
solana-vault basket redeem-single --vault-id <ID> --asset usdc --shares 500000
solana-vault basket redeem-proportional --vault-id <ID> --shares 1000000
solana-vault basket rebalance --vault-id <ID> --from usdc --to sol --amount 500000
solana-vault basket info --vault-id <ID>

# Admin (authority only)
solana-vault pause my-vault         # Emergency pause
solana-vault sync my-vault          # Sync balance (SVS-2/4)
```

**Global flags:** --dry-run, --yes, --output json, --keypair <path>, --url <rpc>

## Core Operations

| Operation | User Action | Rounding | Favors |
|-----------|-------------|----------|--------|
| **deposit** | Pay exact assets -> receive shares | Floor | Vault |
| **mint** | Receive exact shares -> pay assets | Ceiling | Vault |
| **withdraw** | Receive exact assets -> burn shares | Ceiling | Vault |
| **redeem** | Burn exact shares -> receive assets | Floor | Vault |

## Architecture

SVS-1/2 (public) and SVS-3/4 (private) are single-asset vaults following ERC-4626.
SVS-8 is a multi-asset basket vault (analog of ERC-7575) with up to 8 assets and a shared share token.

## PDA Derivation

### SVS-1 through SVS-4 Vault PDA

**Seeds:** ["vault", asset_mint, vault_id (u64 LE)]

### SVS-8 Multi-Asset Vault PDA

**Seeds:** ["multi_vault", vault_id (8 bytes)]

```typescript
const [vaultPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("multi_vault"), Buffer.from(vaultId)],
  svs8ProgramId
);
```

## Instructions

### SVS-1 through SVS-4 Core Operations

| Instruction | Description |
|-------------|-------------|
| initialize | Create new vault |
| deposit | Deposit assets, receive shares |
| mint | Mint exact shares, pay assets |
| withdraw | Withdraw exact assets, burn shares |
| redeem | Burn shares, receive assets |

### SVS-8 Operations

| Instruction | Description |
|-------------|-------------|
| initialize_vault | Create multi-asset vault with up to 8 assets |
| add_asset | Add an asset to the basket |
| remove_asset | Remove an asset from the basket |
| update_weights | Update asset weight targets |
| deposit_single | Deposit one asset, receive shares |
| deposit_proportional | Deposit all assets proportionally, receive shares |
| redeem_single | Burn shares, receive one asset |
| redeem_proportional | Burn shares, receive all assets proportionally |
| rebalance | Rebalance between two assets |
| pause_vault | Emergency pause |
| resume_vault | Resume operations |
| emergency_withdraw | Emergency drain all assets |

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | ZeroAmount | Amount must be > 0 |
| 6001 | SlippageExceeded | Slippage tolerance exceeded |
| 6002 | VaultPaused | Vault is paused |
| 6003 | InvalidAssetDecimals | Asset decimals > 9 |
| 6004 | MathOverflow | Arithmetic overflow |
| 6005 | DivisionByZero | Division by zero |
| 6006 | InsufficientShares | Not enough shares |
| 6007 | InsufficientAssets | Not enough assets |
| 6008 | Unauthorized | Not vault authority |
| 6009 | DepositTooSmall | Below minimum deposit |
| 6010 | AccountNotConfigured | Account not configured for confidential transfers |
| 6011 | PendingBalanceNotApplied | Pending balance not applied |
| 6012 | InvalidProof | Invalid ZK proof data |
| 6013 | ConfidentialTransferNotInitialized | CT extension not initialized |
| 6014 | InvalidCiphertext | Invalid ciphertext format |

## Events

| Event | Description |
|-------|-------------|
| VaultInitialized | New vault created |
| Deposit | Assets deposited |
| Withdraw | Assets withdrawn |
| VaultSynced | Total assets synced (SVS-2, SVS-4 only) |
| VaultStatusChanged | Pause/unpause |
| AuthorityTransferred | Authority changed |

## Security

**Key Features:**
- Virtual offset inflation attack protection
- Vault-favoring rounding strategy
- Slippage protection on all operations
- Emergency pause mechanism
- Checked arithmetic throughout
- PDA bumps stored (not recalculated)
- SVS-1/SVS-3/SVS-8 use live balance (no sync timing attack)

**Audit Status:** Not audited. Use at your own risk.

## Testing

```bash
# Build all programs
anchor build

# Run all tests (130 tests, requires proof backend for SVS-3/SVS-4)
anchor test

# Run SVS-8 tests
anchor test -- --grep "svs-8"

# Run with modules feature (includes 16 module tests)
anchor build -p svs-1 -- --features modules && anchor test --skip-build

# Run SDK tests (460+ tests)
cd sdk/core && npm test

# Run SVS-8 SDK tests only
cd sdk/core && npm test -- basket-vault

# E2E test for SVS-8 on devnet
export RPC_URL="https://api.devnet.solana.com"
npx ts-node scripts/svs-8/e2e-svs8.ts

# Fuzz tests (requires trident)
cd trident-tests && cargo test-fuzz fuzz_svs8

# Backend tests (19 tests)
cd proofs-backend && cargo test
```

## Project Structure

```
solana-vault-standard/
├── programs/
│   ├── svs-1/              # Public vault, live balance
│   ├── svs-2/              # Public vault, stored balance
│   ├── svs-3/              # Private vault, live balance (beta)
│   ├── svs-4/              # Private vault, stored balance (beta)
│   └── svs-8/              # Multi-asset basket vault (SVS-8)
│       └── src/
│           ├── lib.rs       # Program entrypoint & instruction routing
│           ├── state.rs     # MultiAssetVault & AssetEntry account structs
│           ├── instructions/
│           │   └── mod.rs   # All 12 instruction handlers
│           ├── errors.rs    # VaultError enum
│           ├── events.rs    # Anchor events for all state changes
│           ├── math.rs      # Portfolio math & fee calculations
│           └── oracle.rs    # Pyth + svs-oracle price feed validation
├── modules/
│   ├── svs-math/           # Shared math (mul_div, rounding, conversion)
│   ├── svs-fees/           # Entry/exit fee calculation
│   ├── svs-caps/           # Global/per-user deposit caps
│   ├── svs-locks/          # Time-locked shares
│   ├── svs-access/         # Whitelist/blacklist + merkle proofs
│   ├── svs-rewards/        # Secondary reward distribution
│   └── svs-oracle/         # Oracle price validation
├── sdk/
│   ├── core/               # @stbr/solana-vault
│   │   └── src/
│   │       ├── basket-vault.ts      # BasketVault SDK class (SVS-8)
│   │       ├── cli/commands/basket/ # CLI basket commands (SVS-8)
│   │       └── tests/
│   │           └── basket-vault.test.ts  # SDK unit tests (vitest)
│   └── privacy/            # @stbr/svs-privacy-sdk
├── proofs-backend/         # Rust proof generation backend
├── scripts/
│   └── svs-8/
│       └── e2e-svs8.ts    # E2E devnet lifecycle test
├── tests/
│   ├── svs-1.ts           # SVS-1 tests
│   ├── svs-2.ts           # SVS-2 tests
│   ├── svs-3.ts           # SVS-3 tests
│   ├── svs-4.ts           # SVS-4 tests
│   └── svs-8.ts           # SVS-8 Anchor bankrun tests
├── trident-tests/
│   └── fuzz_tests/
│       └── fuzz_svs8/
│           └── fuzz_target.rs  # Trident fuzz targets
└── docs/
    ├── ARCHITECTURE.md
    ├── SVS-1.md
    ├── SVS-2.md
    ├── SVS-3.md
    ├── SVS-4.md
    └── SVS-8.md            # Complete SVS-8 specification
```

## Resources

- [ERC-4626 Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [ERC-7575 Multi-Asset Vault](https://eips.ethereum.org/EIPS/eip-7575)
- [ERC-4626 on Solana](https://solana.com/pt/developers/evm-to-svm/erc4626)
- [Token-2022 Confidential Transfers](https://solana.com/docs/tokens/extensions/confidential-transfer)
- [Pyth Network Price Feeds](https://pyth.network/)
- [Anchor Documentation](https://www.anchor-lang.com/)

## License

Apache 2.0

## Disclaimer

This software is provided "as is" without warranty. Use at your own risk. Not audited.
Private vaults (SVS-3, SVS-4) require the Rust proofs backend for full functionality.
