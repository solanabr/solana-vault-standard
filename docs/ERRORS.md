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

## SVS-11 NAV Oracle Errors

These errors live in the SVS-11 `VaultError` enum and back the pluggable oracle interface read path. Code numbers are Anchor-assigned in declaration order. See [nav-oracle.md](nav-oracle.md) for the adapter contract.

| Name | Message | When Thrown |
|------|---------|-------------|
| `OracleStale` | Oracle price data is stale | Oracle timestamp older than `max_staleness` |
| `OracleInvalidPrice` | Oracle price is invalid | Oracle reports a zero or otherwise invalid price |
| `OracleInvalidProgram` | Oracle account owner does not match vault.oracle_program | Oracle account not owned by the configured oracle program |
| `OracleSequenceStale` | Oracle sequence has not advanced (replay) | Oracle header sequence not strictly greater than last seen |
| `InvalidMintAccount` | Mint account does not deserialize as a valid Token-2022 mint | Shares mint fails Token-2022 deserialization |
| `HookExtrasMismatch` | remaining_accounts do not match the shares mint's ExtraAccountMetaList | Hook extras wrong order, missing accounts, or stale hook config |

---

## nav-oracle errors

[nav-oracle](nav-oracle.md) errors start at 7000 to keep them disjoint from SVS vault error ranges. All codes are explicitly assigned (not Anchor auto-incremented).

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 7000 | `StaleSequence` | Sequence must increment monotonically | `update` with sequence ≤ stored sequence |
| 7001 | `InvalidSignature` | Signature does not match publisher key over canonical payload | Ed25519 precompile scan fails to find a matching `(pubkey, msg, sig)` triple |
| 7002 | `InconsistentNav` | Self-consistency check failed: nav_net != nav_gross × (1 − ter − loss) | `update` payload fails self-consistency |
| 7003 | `UnauthorizedRotation` | Publisher rotation requires the pool's live CreditVault.authority as signer | `rotate_publisher` without the pool's current CreditVault.authority as signer |
| 7004 | `UnauthorizedPublisher` | Caller is not the registered publisher for this NavAccount | Update signed by a key other than `NavAccount.publisher` |
| 7005 | `TimestampInFuture` | Timestamp must not be in the future | `update` payload timestamp > on-chain clock |
| 7012 | `DeviationExceeded` | New NAV deviates more than max_deviation_bps from the previously published NAV | `update` where the new NAV moves beyond `max_deviation_bps` vs the prior published NAV |
| 7013 | `InvalidDeviationConfig` | max_deviation_bps must be > 0 (a zero ceiling rejects every consecutive publish) | `initialize` with `max_deviation_bps = 0` |

---

## compliance-hook errors

[compliance-hook](compliance-hook.md) errors start at 6000 (the program is independent of any SVS vault, so its range can overlap freely without ambiguity — clients disambiguate by program id).

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6000 | `SanctionedAddress` | Source or destination address is on the sanctions list | `execute` with either wallet on the global `SanctionsList` |
| 6001 | `AccountFrozen` | Source or destination account is frozen | `execute` with a `FrozenAccount` PDA present for either wallet |
| 6002 | `AttestationNotFound` | Destination wallet does not have a valid attestation | `Permissioned` mode transfer without attestation on destination |
| 6003 | `AttestationRevoked` | Destination attestation is revoked | Destination attestation `revoked` flag set |
| 6004 | `AttestationExpired` | Destination attestation has expired | Destination attestation past expiry |
| 6005 | `SanctionsListFull` | Sanctions list update would exceed max capacity | `update_sanctions_list` would push past `MAX_ADDRESSES` |
| 6006 | `UnauthorizedAuthority` | Update authority does not match SanctionsList authority | `update_sanctions_list` signed by wrong key |
| 6007 | `InvestorClassTooLow` | Pool policy requires higher investor class than attestation provides | `Permissioned` transfer where attestation class < pool policy |
| 6008 | `JurisdictionNotPermitted` | Pool policy does not permit this jurisdiction | `Permissioned` transfer where attestation jurisdiction is excluded |
| 6009 | `InvalidMintAccount` | Mint account does not deserialize as a valid Token-2022 mint | `initialize_mint_config` with non-Token-2022 mint |
| 6010 | `MissingPoolPolicyForPermissioned` | Permissioned mode requires a pool_policy | `initialize_mint_config` with `Permissioned` mode and no policy |
| 6011 | `PoolPolicySetOnFreelyTransferable` | FreelyTransferable mode rejects a pool_policy (must be None) | `initialize_mint_config` with `FreelyTransferable` mode and a policy supplied |
| 6012 | `InvalidAttestationProgram` | Attestation account is not owned by the mint-configured attestation program | Permissioned transfer with wrong attestation owner |
| 6013 | `InvalidAttestationSubject` | Attestation subject does not match the source/destination ATA owner | Permissioned transfer with foreign attestation |
| 6014 | `InvalidAttestationIssuer` | Attestation issuer does not match the mint-configured issuer | Permissioned transfer with wrong issuer |
| 6015 | `InvalidAttestationType` | Attestation type does not match the mint-required type | Permissioned transfer with wrong attestation tier/type |
| 6016 | `InvalidAttestationPda` | Attestation account address does not match canonical PDA derivation | Permissioned transfer with misderived attestation PDA |
| 6017 | `InvalidAttestationConfig` | Permissioned trust anchors are missing/default | Permissioned MintConfig with unset attestation program or issuer |

---

## derwa-wrapper errors

[derwa-wrapper](derwa-wrapper.md) errors start at 8000 to keep its range distinct from SVS vault and compliance-hook error spaces.

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 8000 | `ZeroAmount` | wrap amount must be greater than zero | `wrap` or `unwrap` with `amount = 0` |
| 8001 | `AttestationRequired` | unwrap requires a valid attestation on the destination wallet | `unwrap` without a valid (non-revoked, non-expired) attestation for the cPOOL recipient |
| 8002 | `InsufficientLockedSupply` | locked supply mismatch: cannot unwrap more than locked | `unwrap` would push `locked_supply` negative |
| 8003 | `MintMismatch` | permissioned mint does not match wrapper config | `wrap` / `unwrap` with cPOOL mint != `WrapperConfig.permissioned_mint` |
| 8004 | `InvalidAttestationProgram` | attestation account owner does not match the wrapper-configured attestation program | `unwrap` with an attestation from the wrong program |
| 8005 | `InvalidAttestationSubject` | attestation subject does not match the unwrap destination wallet | `unwrap` with another wallet's attestation |
| 8006 | `InvalidAttestationIssuer` | attestation issuer does not match the wrapper-configured issuer | `unwrap` with wrong issuer |
| 8007 | `InvalidAttestationType` | attestation type does not match the wrapper-required type | `unwrap` with wrong attestation tier/type |
| 8008 | `InvalidAttestationPda` | attestation account address does not match canonical PDA derivation | `unwrap` with a misderived attestation PDA |
| 8009 | `InvalidAttestationConfig` | wrapper trust anchors are missing/default | `initialize` with unset attestation program or issuer |

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
| SVS-11 | 6000-6xxx | CreditVault (Anchor-assigned, includes NAV oracle adapter codes) |
| svs-fees | 6100-6109 | Fee module errors |
| svs-caps | 6110-6119 | Cap module errors |
| svs-locks | 6120-6129 | Lock module errors |
| svs-access | 6130-6139 | Access control errors |
| svs-rewards | 6140-6149 | Rewards module errors |
| compliance-hook | 6000-6017 | TransferHook compliance errors (Token-2022) |
| nav-oracle | 7000-7013 | Per-pool NAV oracle errors |
| derwa-wrapper | 8000-8009 | cPOOL ↔ dePOOL wrap errors |
