# SVS Constants Reference

This document lists all constants used across SVS vault variants and modules.

---

## Core Constants

### PDA Seeds

From `programs/svs-{N}/src/constants.rs`:

| Constant | Value | Purpose |
|----------|-------|---------|
| `VAULT_SEED` | `b"vault"` | Vault PDA derivation |
| `SHARES_MINT_SEED` | `b"shares"` | Shares mint PDA derivation |

```rust
pub const VAULT_SEED: &[u8] = b"vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
```

### PDA Derivation

```rust
// Vault PDA
seeds = [VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()]

// Shares Mint PDA
seeds = [SHARES_MINT_SEED, vault.key().as_ref()]
```

---

## Numeric Constants

### Decimal Configuration

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_DECIMALS` | `9` | Maximum supported asset decimals |
| `SHARES_DECIMALS` | `9` | Fixed decimals for share tokens |

```rust
pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
```

### Deposit Limits

| Constant | Value | Purpose |
|----------|-------|---------|
| `MIN_DEPOSIT_AMOUNT` | `1000` | Minimum deposit (anti-dust) |

```rust
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;
```

---

## Virtual Offset Calculation

The virtual offset protects against inflation attacks:

```rust
decimals_offset = MAX_DECIMALS - asset_decimals  // 9 - asset_decimals
offset = 10^decimals_offset
```

### Examples by Asset Type

| Asset | Decimals | decimals_offset | offset (10^offset) |
|-------|----------|-----------------|-------------------|
| USDC | 6 | 3 | 1,000 |
| USDT | 6 | 3 | 1,000 |
| SOL | 9 | 0 | 1 |
| wBTC | 8 | 1 | 10 |
| Custom (0) | 0 | 9 | 1,000,000,000 |

---

## Account Sizes

### Vault State (SVS-1, SVS-2)

| Field | Size (bytes) |
|-------|-------------|
| Discriminator | 8 |
| authority | 32 |
| asset_mint | 32 |
| shares_mint | 32 |
| asset_vault | 32 |
| total_assets | 8 |
| decimals_offset | 1 |
| bump | 1 |
| paused | 1 |
| vault_id | 8 |
| _reserved | 64 |
| **Total** | **219** |

```rust
impl Vault {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 1 + 1 + 1 + 8 + 64;
}
```

### ConfidentialVault State (SVS-3, SVS-4)

| Field | Size (bytes) |
|-------|-------------|
| (Vault fields) | 155 |
| auditor_elgamal_pubkey | 33 (1 + 32 Option) |
| confidential_authority | 32 |
| _reserved | 32 |
| **Total** | **252** |

---

## Module Constants

### svs-fees

| Constant | Value | Purpose |
|----------|-------|---------|
| `FEE_CONFIG_SEED` | `b"fee_config"` | Fee config PDA |
| `MAX_ENTRY_FEE_BPS` | `1000` | 10% max entry fee |
| `MAX_EXIT_FEE_BPS` | `1000` | 10% max exit fee |
| `MAX_MANAGEMENT_FEE_BPS` | `500` | 5% max annual management fee |
| `MAX_PERFORMANCE_FEE_BPS` | `3000` | 30% max performance fee |
| `BPS_DENOMINATOR` | `10000` | Basis points denominator |

```rust
pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";
// seeds = [FEE_CONFIG_SEED, vault.key().as_ref()]
```

### svs-caps

| Constant | Value | Purpose |
|----------|-------|---------|
| `CAP_CONFIG_SEED` | `b"cap_config"` | Cap config PDA |
| `USER_DEPOSIT_SEED` | `b"user_deposit"` | Per-user deposit tracking PDA |

```rust
pub const CAP_CONFIG_SEED: &[u8] = b"cap_config";
pub const USER_DEPOSIT_SEED: &[u8] = b"user_deposit";
// cap_config seeds = [CAP_CONFIG_SEED, vault.key().as_ref()]
// user_deposit seeds = [USER_DEPOSIT_SEED, vault.key().as_ref(), user.key().as_ref()]
```

### svs-locks

| Constant | Value | Purpose |
|----------|-------|---------|
| `LOCK_CONFIG_SEED` | `b"lock_config"` | Lock config PDA |
| `SHARE_LOCK_SEED` | `b"share_lock"` | Per-user lock tracking PDA |

```rust
pub const LOCK_CONFIG_SEED: &[u8] = b"lock_config";
pub const SHARE_LOCK_SEED: &[u8] = b"share_lock";
// lock_config seeds = [LOCK_CONFIG_SEED, vault.key().as_ref()]
// share_lock seeds = [SHARE_LOCK_SEED, vault.key().as_ref(), owner.key().as_ref()]
```

### svs-access

| Constant | Value | Purpose |
|----------|-------|---------|
| `ACCESS_CONFIG_SEED` | `b"access_config"` | Access config PDA |
| `FROZEN_ACCOUNT_SEED` | `b"frozen"` | Frozen account marker PDA |

```rust
pub const ACCESS_CONFIG_SEED: &[u8] = b"access_config";
pub const FROZEN_ACCOUNT_SEED: &[u8] = b"frozen";
// access_config seeds = [ACCESS_CONFIG_SEED, vault.key().as_ref()]
// frozen seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), user.key().as_ref()]
```

### svs-rewards

| Constant | Value | Purpose |
|----------|-------|---------|
| `REWARD_CONFIG_SEED` | `b"reward_config"` | Reward config PDA |
| `USER_REWARD_SEED` | `b"user_reward"` | Per-user reward tracking PDA |
| `PRECISION` | `10^18` | Accumulated per share precision |

```rust
pub const REWARD_CONFIG_SEED: &[u8] = b"reward_config";
pub const USER_REWARD_SEED: &[u8] = b"user_reward";
pub const PRECISION: u128 = 1_000_000_000_000_000_000;  // 10^18
// reward_config seeds = [REWARD_CONFIG_SEED, vault.key().as_ref(), reward_mint.key().as_ref()]
// user_reward seeds = [USER_REWARD_SEED, vault.key().as_ref(), reward_mint.key().as_ref(), user.key().as_ref()]
```

---

## Extended Variant Constants

### SVS-5/6 (Streaming)

| Constant | Value | Purpose |
|----------|-------|---------|
| `MIN_STREAM_DURATION` | `3600` | 1 hour minimum stream |
| `MAX_STREAM_DURATION` | `31536000` | 1 year maximum stream |

### SVS-7 (Native SOL)

| Constant | Value | Purpose |
|----------|-------|---------|
| `WSOL_MINT` | `So11...1112` | Wrapped SOL mint address |
| `RENT_EXEMPT_MINIMUM` | ~`2039280` | Rent-exempt minimum for token account |

### SVS-8 (Multi-Asset)

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_ASSETS` | `8` | Maximum assets per vault |
| `MAX_STALENESS` | `60` | Oracle staleness limit (seconds) |
| `ASSET_ENTRY_SEED` | `b"asset_entry"` | Per-asset config PDA |

### SVS-9 (Allocator)

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_CHILDREN` | `10` | Maximum child vaults |
| `CHILD_ALLOCATION_SEED` | `b"child_allocation"` | Per-child allocation PDA |
| `MIN_IDLE_BUFFER_BPS` | `500` | 5% minimum idle buffer |

### SVS-10/11 (Async)

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEPOSIT_REQUEST_SEED` | `b"deposit_request"` | Deposit request PDA |
| `REDEEM_REQUEST_SEED` | `b"redeem_request"` | Redeem request PDA |
| `REQUEST_EXPIRY` | `604800` | 7 days request expiry |

### SVS-12 (Tranched)

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_TRANCHES` | `4` | Maximum tranches per vault |
| `TRANCHE_SEED` | `b"tranche"` | Per-tranche PDA |
| `MIN_SUBORDINATION_BPS` | `1000` | 10% minimum subordination |

---

## TypeScript SDK Constants

```typescript
// From sdk/core/src/constants.ts
export const VAULT_SEED = Buffer.from('vault');
export const SHARES_MINT_SEED = Buffer.from('shares');

export const MAX_DECIMALS = 9;
export const SHARES_DECIMALS = 9;
export const MIN_DEPOSIT_AMOUNT = 1000n;

export const BPS_DENOMINATOR = 10000n;

// Program IDs (devnet)
export const SVS_1_PROGRAM_ID = new PublicKey('Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC');
export const SVS_2_PROGRAM_ID = new PublicKey('3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD');
export const SVS_3_PROGRAM_ID = new PublicKey('EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh');
export const SVS_4_PROGRAM_ID = new PublicKey('2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY');
```

---

## PDA Derivation Examples

### TypeScript

```typescript
import { PublicKey } from '@solana/web3.js';

// Vault PDA
const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
  [
    VAULT_SEED,
    assetMint.toBuffer(),
    new BN(vaultId).toArrayLike(Buffer, 'le', 8),
  ],
  SVS_1_PROGRAM_ID
);

// Shares Mint PDA
const [sharesMintPda, sharesMintBump] = PublicKey.findProgramAddressSync(
  [SHARES_MINT_SEED, vaultPda.toBuffer()],
  SVS_1_PROGRAM_ID
);

// Module Config PDAs
const [feeConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('fee_config'), vaultPda.toBuffer()],
  SVS_1_PROGRAM_ID
);

const [userDepositPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('user_deposit'), vaultPda.toBuffer(), userPubkey.toBuffer()],
  SVS_1_PROGRAM_ID
);
```

### Rust

```rust
use anchor_lang::prelude::*;

// Vault PDA
let (vault_pda, vault_bump) = Pubkey::find_program_address(
    &[
        VAULT_SEED,
        asset_mint.as_ref(),
        &vault_id.to_le_bytes(),
    ],
    &program_id,
);

// Shares Mint PDA
let (shares_mint_pda, _) = Pubkey::find_program_address(
    &[SHARES_MINT_SEED, vault_pda.as_ref()],
    &program_id,
);
```
