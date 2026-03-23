# Solana Vault Standard (SVS)

Tokenized vault programs and TypeScript SDK for building yield-bearing vaults on Solana. The SDK provides deposit/withdraw operations, share accounting, preview functions, and modular extensions for fees, caps, access control, timelocks, and multi-asset portfolios. The interface follows the ERC-4626 specification adapted for Solana's account model.

## SVS Variants

| Version | Name | Balance Model | Privacy | Sync | Status |
|---------|------|---------------|---------|------|--------|
| **SVS-1** | Public Vault (Live) | Live balance | None | No sync needed | ✅ Devnet |
| **SVS-2** | Public Vault (Stored) | Stored balance | None | Requires sync() | ✅ Devnet |
| **SVS-3** | Private Vault (Live) | Live balance | Encrypted | No sync needed | ✅ Devnet |
| **SVS-4** | Private Vault (Stored) | Stored balance | Encrypted | Requires sync() | ✅ Devnet |
| **SVS-5** | Streaming Yield Vault | Interpolated balance | None | distribute_yield() + checkpoint() | ✅ Devnet |
| **SVS-6** | Streaming Private Vault | Interpolated balance | None | distribute_yield() + checkpoint() | ✅ Devnet |

### Balance Model Comparison

**Live Balance (SVS-1, SVS-3):**
- Uses `asset_vault.amount` directly for all calculations
- External donations/yield immediately reflected in share price
- No sync timing attack vulnerability
- No sync() function needed

**Stored Balance (SVS-2, SVS-4):**
- Uses `vault.total_assets` stored in account
- Requires `sync()` call to recognize external donations
- Authority controls when yield is recognized
- May be preferred for yield strategies that require controlled distribution

**Streaming Balance (SVS-5):**
- Uses `base_assets + accrued_stream_yield` computed at current timestamp
- Yield distributed linearly over configurable duration via `distribute_yield(amount, duration)`
- `checkpoint()` materializes accrued yield into `base_assets` (permissionless)
- Eliminates MEV from front-running discrete sync/yield operations
- Suited for payroll vaults, vesting schedules, DCA strategies

### Privacy Model

**Public (SVS-1, SVS-2):**
- Token-2022 shares mint (no extensions)
- All balances visible on-chain
- Simple, auditable, production-ready

**Private (SVS-3, SVS-4):**
- Token-2022 with Confidential Transfers extension
- Share balances encrypted with ElGamal
- Only owner can decrypt their balance
- Requires [Rust proof backend](proofs-backend/README.md) for ZK proof generation

## Program IDs

| Program | Devnet | Localnet |
|---------|--------|----------|
| SVS-1 | `Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC` | Same as devnet |
| SVS-2 | `3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD` | Same as devnet |
| SVS-3 | `EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh` | Same as devnet |
| SVS-4 | `2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY` | Same as devnet |
| SVS-5 | `3XQX3ZKGcy618XyWMmQiukYohJNSh3JNWoffq8ZeFdcS` | Same as devnet |

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
import { SolanaVault, ManagedVault, StreamingVault } from "@stbr/solana-vault";
import { BN } from "@coral-xyz/anchor";

// SVS-1: Load live-balance vault
const vault = await SolanaVault.load(program, assetMint, 1);

// SVS-2: Load stored-balance vault (adds sync())
const managed = await ManagedVault.load(program, assetMint, 1);

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

// SVS-5: Load streaming yield vault
const streaming = await StreamingVault.load(program, assetMint, 1);

// Distribute yield over 1 hour
await streaming.distributeYield(authority, new BN(1_000_000), new BN(3600));

// Permissionless checkpoint
await streaming.checkpoint();
```

## Features

| Feature | Description |
|---------|-------------|
| **Inflation Attack Protection** | Virtual offset mechanism prevents donation attacks |
| **Vault-Favoring Rounding** | All operations round to protect vault solvency |
| **Slippage Protection** | Min/max parameters prevent sandwich attacks |
| **Multi-Vault Support** | Multiple vaults per asset via `vault_id` |
| **Emergency Controls** | Pause/unpause and authority transfer |
| **CPI-Composable Views** | Preview functions callable from other programs |

## On-Chain Modules (SVS-1)

SVS-1 includes optional on-chain modules for enforcing vault policies at the program level. Build with `--features modules` to enable.

| Module | Description |
|--------|-------------|
| `svs-fees` | Entry/exit fees (max 10%), collected later via admin instruction |
| `svs-caps` | Global and per-user deposit caps with bypass prevention |
| `svs-locks` | Time-locked shares before redemption (max 1 year) |
| `svs-access` | Whitelist/blacklist with merkle proof verification |

**Module PDAs** are passed via `remaining_accounts`. If not passed, checks are skipped (backward compatible).

```bash
# Build SVS-1 with modules
anchor build -p svs-1 -- --features modules
```

## SDK Extensions

The TypeScript SDK includes modular extensions for common vault patterns:

| Module | Description |
|--------|-------------|
| `fees` | Management, performance, and entry/exit fee calculation |
| `cap` | Global and per-user deposit caps |
| `emergency` | Emergency withdrawal with configurable penalty |
| `access-control` | Whitelist/blacklist with merkle proof verification |
| `multi-asset` | Portfolio allocation across multiple vaults |
| `timelock` | Governance proposal lifecycle management |
| `strategy` | CPI templates for deploying assets to external protocols |

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
solana-vault info my-vault                    # View vault state
solana-vault balance my-vault                 # Check your balance
solana-vault deposit my-vault -a 1000000      # Deposit assets
solana-vault withdraw my-vault -a 500000      # Withdraw assets
solana-vault dashboard my-vault               # Live monitoring

# Admin (authority only)
solana-vault pause my-vault                   # Emergency pause
solana-vault sync my-vault                    # Sync balance (SVS-2/4)
```

**Global flags:** `--dry-run`, `--yes`, `--output json`, `--keypair <path>`, `--url <rpc>`

## Core Operations

| Operation | User Action | Rounding | Favors |
|-----------|-------------|----------|--------|
| **deposit** | Pay exact assets → receive shares | Floor | Vault |
| **mint** | Receive exact shares → pay assets | Ceiling | Vault |
| **withdraw** | Receive exact assets → burn shares | Ceiling | Vault |
| **redeem** | Burn exact shares → receive assets | Floor | Vault |

## Architecture

```
+--------------------------------------------------------------------+
|                    Solana Vault Standard                           |
+--------------------------------------------------------------------+
|                                                                    |
|   PUBLIC VAULTS                     PRIVATE VAULTS                 |
|   +------------------+              +------------------+           |
|   |                  |              |                  |           |
|   | SVS-1            | Live         | SVS-3            | Live      |
|   | (No sync needed) | Balance      | (No sync needed) | Balance   |
|   |                  |              |                  |           |
|   +------------------+              +------------------+           |
|   |                  |              |                  |           |
|   | SVS-2            | Stored       | SVS-4            | Stored    |
|   | (sync() for      | Balance      | (sync() for      | Balance   |
|   |  yield accrual)  |              |  yield accrual)  |           |
|   +------------------+              +--------+---------+           |
|   |                  |                                             |
|   | SVS-5            | Streaming                                   |
|   | (distribute_yield| Balance                                     |
|   |  + checkpoint)   |                                             |
|   +------------------+                                             |
|            |                                 |                     |
|            v                                 v                     |
|   +------------------+              +------------------+           |
|   |  SPL Token       |              |  Token-2022      |           |
|   |  (public u64)    |              |  + CT Extension  |           |
|   +------------------+              |  (encrypted)     |           |
|                                     +--------+---------+           |
|                                              |                     |
|                                              v                     |
|                                     +------------------+           |
|                                     |  Proofs Backend  |           |
|                                     |  (Rust/Axum)     |           |
|                                     +--------+---------+           |
|                                              |                     |
|                                              v                     |
|                                     +------------------+           |
|                                     |  ZK ElGamal      |           |
|                                     |  Proof Program   |           |
|                                     +------------------+           |
+--------------------------------------------------------------------+
```

## PDA Derivation

### Vault PDA
**Seeds:** `["vault", asset_mint, vault_id (u64 LE)]`

> **SVS-5 note:** StreamVault uses seed `"stream_vault"` instead of `"vault"`.

```typescript
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
  programId
);
```

### Shares Mint PDA
**Seeds:** `["shares", vault_pubkey]`

```typescript
const [sharesMint] = PublicKey.findProgramAddressSync(
  [Buffer.from("shares"), vault.toBuffer()],
  programId
);
```

## Instructions

### Core Operations (All Programs)

| Instruction | Description |
|-------------|-------------|
| `initialize` | Create new vault |
| `deposit` | Deposit assets, receive shares |
| `mint` | Mint exact shares, pay assets |
| `withdraw` | Withdraw exact assets, burn shares |
| `redeem` | Burn shares, receive assets |

### Admin Operations

| Instruction | SVS-1 | SVS-2 | SVS-3 | SVS-4 | SVS-5 | Description |
|-------------|:-----:|:-----:|:-----:|:-----:|:-----:|-------------|
| `pause` | ✓ | ✓ | ✓ | ✓ | ✓ | Emergency pause vault |
| `unpause` | ✓ | ✓ | ✓ | ✓ | ✓ | Resume operations |
| `transfer_authority` | ✓ | ✓ | ✓ | ✓ | ✓ | Transfer admin rights |
| `sync` | ✗ | ✓ | ✗ | ✓ | ✗ | Sync total_assets with balance |
| `distribute_yield` | ✗ | ✗ | ✗ | ✗ | ✓ | Start streaming yield distribution |
| `checkpoint` | ✗ | ✗ | ✗ | ✗ | ✓ | Materialize accrued yield (permissionless) |

### View Functions (All Programs)

| Instruction | Description |
|-------------|-------------|
| `preview_deposit` | Preview shares for asset deposit |
| `preview_mint` | Preview assets needed for share mint |
| `preview_withdraw` | Preview shares burned for asset withdrawal |
| `preview_redeem` | Preview assets received for share redemption |
| `convert_to_shares` | Convert asset amount to shares |
| `convert_to_assets` | Convert share amount to assets |
| `total_assets` | Get total vault assets |
| `max_deposit` | Get maximum deposit amount |
| `max_mint` | Get maximum mint amount |
| `max_withdraw` | Get maximum withdraw amount |
| `max_redeem` | Get maximum redeem amount |

**SVS-3/SVS-4 view difference**: `max_withdraw` returns the vault's total assets (not user-specific) and `max_redeem` returns `u64::MAX`, because encrypted share balances can't be read on-chain. SVS-1/SVS-2 return user-specific values based on `owner_shares_account.amount`.

**SVS-5 view addition**: `get_stream_info` returns current stream parameters (base_assets, stream_amount, stream_start, stream_end). All view functions use `effective_total_assets(now)` for share price computation.

### Private Vault Only (SVS-3, SVS-4)

| Instruction | Description |
|-------------|-------------|
| `configure_account` | Enable confidential mode on user account |
| `apply_pending` | Move pending balance to available |

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
| `VaultInitialized` | New vault created |
| `Deposit` | Assets deposited |
| `Withdraw` | Assets withdrawn |
| `VaultSynced` | Total assets synced (SVS-2, SVS-4 only) |
| `YieldStreamStarted` | Yield stream started (SVS-5 only) |
| `Checkpoint` | Yield materialized into base_assets (SVS-5 only) |
| `VaultStatusChanged` | Pause/unpause |
| `AuthorityTransferred` | Authority changed |

## Security

**Key Features:**
- Virtual offset inflation attack protection
- Vault-favoring rounding strategy
- Slippage protection on all operations
- Emergency pause mechanism
- Checked arithmetic throughout
- PDA bumps stored (not recalculated)
- SVS-1/SVS-3 use live balance (no sync timing attack)

**Audit Status:** Not audited. Use at your own risk.

## Testing

```bash
# Build all programs
anchor build

# Run all tests (165+ tests, requires proof backend for SVS-3/SVS-4)
anchor test

# Run with modules feature (includes 16 module tests)
anchor build -p svs-1 -- --features modules && anchor test --skip-build

# Run SDK tests (460 tests)
cd sdk/core && npm test

# Run SVS-1 tests only
anchor test -- --grep "svs-1"

# Run specific test file
anchor test -- --grep "yield"

# Backend tests (19 tests)
cd proofs-backend && cargo test

# Start proof backend (required for SVS-3/SVS-4 CT tests)
cd proofs-backend && cargo run
```

## Project Structure

```
solana-vault-standard/
├── programs/
│   ├── svs-1/                    # Public vault, live balance
│   ├── svs-2/                    # Public vault, stored balance
│   ├── svs-3/                    # Private vault, live balance (beta)
│   ├── svs-4/                    # Private vault, stored balance (beta)
│   └── svs-5/                    # Streaming yield vault
├── modules/
│   ├── svs-math/                 # Shared math (mul_div, rounding, conversion)
│   ├── svs-fees/                 # Entry/exit fee calculation
│   ├── svs-caps/                 # Global/per-user deposit caps
│   ├── svs-locks/                # Time-locked shares
│   ├── svs-access/               # Whitelist/blacklist + merkle proofs
│   ├── svs-rewards/              # Secondary reward distribution
│   └── svs-oracle/               # Oracle price validation
├── sdk/
│   ├── core/                     # @stbr/solana-vault
│   └── privacy/                  # @stbr/svs-privacy-sdk
├── proofs-backend/               # Rust proof generation backend
│   ├── src/
│   ├── Cargo.toml
│   ├── Dockerfile
│   └── README.md
├── tests/
│   ├── svs-1.ts                  # SVS-1 public vault tests (26)
│   ├── svs-2.ts                  # SVS-2 stored balance + sync tests (35)
│   ├── svs-3.ts                  # SVS-3 confidential live balance tests (42)
│   ├── svs-4.ts                  # SVS-4 confidential stored balance tests (43)
│   ├── svs-5.ts                  # SVS-5 streaming yield tests (35)
│   ├── helpers/
│   │   └── proof-client.ts       # ZK proof backend client helpers
│   ├── admin-extended.ts         # Admin function tests
│   ├── decimals.ts               # Multi-decimal tests
│   ├── edge-cases.ts             # Edge case tests
│   ├── full-lifecycle.ts         # Full lifecycle tests
│   ├── invariants.ts             # Invariant tests
│   ├── multi-user.ts             # Multi-user tests
│   └── yield-sync.ts             # Yield/live balance tests
└── docs/
    ├── ARCHITECTURE.md          # Technical architecture
    ├── CLI.md                   # CLI reference
    ├── DEPLOYMENT.md            # Deployment guide
    ├── PRIVACY.md               # Privacy model & proof backend
    ├── SDK.md                   # SDK usage guide
    ├── SECURITY.md              # Attack vectors & mitigations
    ├── TESTING.md               # Test guide & coverage
    ├── SVS-1.md                 # SVS-1 spec (live balance)
    ├── SVS-2.md                 # SVS-2 spec (stored balance + sync)
    ├── SVS-3.md                 # SVS-3 spec (confidential live)
    ├── SVS-4.md                 # SVS-4 spec (confidential stored)
    └── SVS-5.md                 # SVS-5 spec (streaming yield)
```

## Resources

- [ERC-4626 Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [ERC-4626 on Solana](https://solana.com/pt/developers/evm-to-svm/erc4626)
- [Token-2022 Confidential Transfers](https://solana.com/docs/tokens/extensions/confidential-transfer)
- [ZK ElGamal Proof Program](https://docs.anza.xyz/runtime/zk-elgamal-proof)
- [Anchor Documentation](https://www.anchor-lang.com/)

## License

Apache 2.0

## Disclaimer

This software is provided "as is" without warranty. Use at your own risk. Not audited. Private vaults (SVS-3, SVS-4) require the Rust proofs backend for full functionality.
