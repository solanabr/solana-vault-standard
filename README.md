# Solana Vault Standard (SVS)

ERC-4626 tokenized vault standard for Solana. Deposit assets, receive proportional share tokens, redeem shares for assets.

## SVS Variants

| Version | Name | Balance Model | Privacy | Sync | Status |
|---------|------|---------------|---------|------|--------|
| **SVS-1** | Public Vault (Live) | Live balance | None | No sync needed | ✅ Production-ready |
| **SVS-2** | Public Vault (Stored) | Stored balance | None | Requires sync() | ✅ Production-ready |
| **SVS-3** | Private Vault (Live) | Live balance | Encrypted | No sync needed | 🔬 Beta |
| **SVS-4** | Private Vault (Stored) | Stored balance | Encrypted | Requires sync() | 🔬 Beta |

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
| SVS-1 | `Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC` | `SVS1VauLt1111111111111111111111111111111111` |
| SVS-2 | `3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD` | `SVS2VauLt2222222222222222222222222222222222` |
| SVS-3 | Not deployed | `SVS3VauLt3333333333333333333333333333333333` |
| SVS-4 | Not deployed | `SVS4VauLt4444444444444444444444444444444444` |

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
import { SolanaVault } from "@stbr/solana-vault";
import { BN } from "@coral-xyz/anchor";

// Load existing vault
const vault = await SolanaVault.load(program, assetMint, 1);

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
```

## Features

| Feature | Description |
|---------|-------------|
| **ERC-4626 Compatible** | Standard interface matching Ethereum's vault standard |
| **Inflation Attack Protection** | Virtual offset mechanism prevents donation attacks |
| **Vault-Favoring Rounding** | All operations round to protect vault solvency |
| **Slippage Protection** | Min/max parameters prevent sandwich attacks |
| **Multi-Vault Support** | Multiple vaults per asset via `vault_id` |
| **Emergency Controls** | Pause/unpause and authority transfer |
| **CPI-Composable Views** | Preview functions callable from other programs |

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

| Instruction | SVS-1 | SVS-2 | SVS-3 | SVS-4 | Description |
|-------------|:-----:|:-----:|:-----:|:-----:|-------------|
| `pause` | ✓ | ✓ | ✓ | ✓ | Emergency pause vault |
| `unpause` | ✓ | ✓ | ✓ | ✓ | Resume operations |
| `transfer_authority` | ✓ | ✓ | ✓ | ✓ | Transfer admin rights |
| `sync` | ✗ | ✓ | ✗ | ✓ | Sync total_assets with balance |

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

# Run all tests
anchor test

# Run SVS-1 tests only
anchor test -- --grep "svs-1"

# Run specific test file
anchor test -- --grep "yield"

# Backend tests
cd proofs-backend && cargo test
```

## Project Structure

```
tokenized-vault-standard/
├── programs/
│   ├── svs-1/                    # Public vault, live balance
│   ├── svs-2/                    # Public vault, stored balance
│   ├── svs-3/                    # Private vault, live balance (beta)
│   └── svs-4/                    # Private vault, stored balance (beta)
├── sdk/
│   ├── core/                     # @stbr/solana-vault
│   └── privacy/                  # @stbr/svs-privacy-sdk
├── proofs-backend/               # Rust proof generation backend
│   ├── src/
│   ├── Cargo.toml
│   ├── Dockerfile
│   └── README.md
├── tests/
│   ├── svs-1.ts                  # SVS-1 public vault tests
│   ├── svs-2.ts                  # SVS-2 stored balance + sync tests
│   ├── admin-extended.ts         # Admin function tests
│   ├── decimals.ts               # Multi-decimal tests
│   ├── edge-cases.ts             # Edge case tests
│   ├── full-lifecycle.ts         # Full lifecycle tests
│   ├── invariants.ts             # Invariant tests
│   ├── multi-user.ts             # Multi-user tests
│   └── yield-sync.ts             # Yield/live balance tests
└── docs/
    ├── ARCHITECTURE.md          # Technical architecture
    ├── PRIVACY.md               # Privacy model & proof backend
    ├── SDK.md                   # SDK usage guide
    ├── SECURITY.md              # Attack vectors & mitigations
    └── TESTING.md               # Test guide & coverage
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
