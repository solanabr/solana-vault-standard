# SVS Error Codes

This document lists all error codes across SVS vault variants. Error codes start at 6000 (Anchor convention for custom errors).

---

## Core Errors (All Variants)

These errors are defined in every SVS program and have consistent codes.

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6000 | `ZeroAmount` | Amount must be greater than zero | `deposit`, `mint`, `withdraw`, `redeem` with 0 amount |
| 6001 | `SlippageExceeded` | Slippage tolerance exceeded | Output doesn't meet min/max threshold |
| 6002 | `VaultPaused` | Vault is paused | Any operation when `vault.paused = true` |
| 6003 | `InvalidAssetDecimals` | Asset decimals must be <= 9 | `initialize` with asset >9 decimals |
| 6004 | `MathOverflow` | Arithmetic overflow | Checked math overflow |
| 6005 | `DivisionByZero` | Division by zero | `mul_div` with zero denominator |
| 6006 | `InsufficientShares` | Insufficient shares balance | `withdraw`, `redeem` without enough shares |
| 6007 | `InsufficientAssets` | Insufficient assets in vault | `withdraw` more than vault holds |
| 6008 | `Unauthorized` | Unauthorized - caller is not vault authority | Admin operations without authority |
| 6009 | `DepositTooSmall` | Deposit amount below minimum threshold | `deposit` below `MIN_DEPOSIT_AMOUNT` |
| 6010 | `VaultNotPaused` | Vault is not paused | `unpause` when already unpaused |

---

## Error Definitions

### Core Enum (SVS-1/2/3/4)

From `programs/svs-{N}/src/error.rs`:

```rust
#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,

    #[msg("Vault is paused")]
    VaultPaused,

    #[msg("Asset decimals must be <= 9")]
    InvalidAssetDecimals,

    #[msg("Arithmetic overflow")]
    MathOverflow,

    #[msg("Division by zero")]
    DivisionByZero,

    #[msg("Insufficient shares balance")]
    InsufficientShares,

    #[msg("Insufficient assets in vault")]
    InsufficientAssets,

    #[msg("Unauthorized - caller is not vault authority")]
    Unauthorized,

    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall,

    #[msg("Vault is not paused")]
    VaultNotPaused,
}
```

---

## SVS-2/4 Additional Errors

Stored balance variants add sync-related errors.

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6011 | `SyncRequired` | Vault balance out of sync | Stale `total_assets` detected |

---

## SVS-3/4 Confidential Errors

Confidential transfer variants add proof-related errors.

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6020 | `InvalidProof` | Invalid zero-knowledge proof | Proof verification failed |
| 6021 | `ProofContextMismatch` | Proof context account mismatch | Wrong proof context passed |
| 6022 | `PendingBalanceNotEmpty` | Pending balance must be empty | `configure_account` with existing pending |
| 6023 | `ConfidentialTransferDisabled` | Confidential transfers not enabled | CT operations on non-CT account |

---

## Module Errors

When modules are enabled, additional error codes are used.

### svs-fees

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6100 | `FeeConfigNotFound` | Fee configuration not initialized | Operations before fee config created |
| 6101 | `FeeTooHigh` | Fee exceeds maximum allowed | Setting fee above BPS limit |
| 6102 | `InvalidFeeRecipient` | Invalid fee recipient | Zero address fee recipient |

### svs-caps

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6110 | `GlobalCapExceeded` | Global deposit cap exceeded | Deposit would exceed global cap |
| 6111 | `UserCapExceeded` | Per-user deposit cap exceeded | Deposit would exceed user cap |
| 6112 | `CapConfigNotFound` | Cap configuration not initialized | Operations before cap config created |

### svs-locks

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6120 | `LockupNotExpired` | Shares are still locked | `withdraw`, `redeem` before lockup ends |
| 6121 | `LockConfigNotFound` | Lock configuration not initialized | Operations before lock config created |

### svs-access

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6130 | `AccessDenied` | Access denied - not whitelisted | User not in whitelist |
| 6131 | `AccountFrozen` | Account is frozen | Operations on frozen account |
| 6132 | `InvalidMerkleProof` | Invalid merkle proof | Proof doesn't verify against root |

### svs-rewards

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6140 | `NoRewardsToClaim` | No rewards available to claim | `claim_rewards` with zero pending |
| 6141 | `RewardConfigNotFound` | Reward configuration not initialized | Operations before reward config created |

---

## Error Handling in Client Code

### TypeScript/Anchor SDK

```typescript
import { AnchorError } from '@coral-xyz/anchor';

try {
  await program.methods.deposit(assets, minSharesOut).accounts({...}).rpc();
} catch (error) {
  if (error instanceof AnchorError) {
    switch (error.error.errorCode.code) {
      case 'ZeroAmount':
        console.error('Cannot deposit zero amount');
        break;
      case 'SlippageExceeded':
        console.error('Slippage too high, try with lower min_shares_out');
        break;
      case 'VaultPaused':
        console.error('Vault is paused, contact admin');
        break;
      case 'InsufficientShares':
        console.error('Not enough shares for this operation');
        break;
      default:
        console.error('Vault error:', error.error.errorMessage);
    }
  }
}
```

### Error Code Extraction

```typescript
// Get numeric code from error
function getErrorCode(error: AnchorError): number {
  return error.error.errorCode.number;
}

// Check specific error
function isSlippageError(error: unknown): boolean {
  return error instanceof AnchorError &&
         error.error.errorCode.code === 'SlippageExceeded';
}
```

---

## Error Prevention

### Input Validation

```typescript
// Client-side validation before transaction
function validateDeposit(assets: bigint, minSharesOut: bigint) {
  if (assets === 0n) {
    throw new Error('ZeroAmount: Cannot deposit zero');
  }
  if (assets < MIN_DEPOSIT_AMOUNT) {
    throw new Error(`DepositTooSmall: Minimum is ${MIN_DEPOSIT_AMOUNT}`);
  }
}
```

### Preview Functions

```typescript
// Use preview to avoid slippage errors
const previewShares = await vault.previewDeposit(assets);
const minSharesOut = previewShares * 99n / 100n;  // 1% slippage tolerance
await vault.deposit(assets, minSharesOut);
```

### Balance Checks

```typescript
// Check balance before withdraw
const userShares = await vault.getShareBalance(user.publicKey);
const requiredShares = await vault.previewWithdraw(assets);
if (userShares < requiredShares) {
  throw new Error(`InsufficientShares: Have ${userShares}, need ${requiredShares}`);
}
```

---

## Constraint Errors

Anchor generates errors for constraint violations. These appear as `ConstraintRaw` errors with the custom message.

### Example Constraint

```rust
#[account(
    constraint = !vault.paused @ VaultError::VaultPaused,
)]
pub vault: Account<'info, Vault>,
```

### Constraint Error Response

```
Error: AnchorError: Vault is paused. Error Code: VaultPaused.
```

---

## Program Error Mapping

| Program | Error Range | Description |
|---------|-------------|-------------|
| SVS-1 | 6000-6010 | Core public vault errors |
| SVS-2 | 6000-6015 | Core + sync errors |
| SVS-3 | 6000-6030 | Core + confidential errors |
| SVS-4 | 6000-6030 | Core + sync + confidential errors |
| svs-fees | 6100-6109 | Fee module errors |
| svs-caps | 6110-6119 | Cap module errors |
| svs-locks | 6120-6129 | Lock module errors |
| svs-access | 6130-6139 | Access control errors |
| svs-rewards | 6140-6149 | Rewards module errors |
