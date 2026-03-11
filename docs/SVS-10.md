# SVS-10: Async Vault (ERC-7540)

## Overview

SVS-10 is the async tokenized vault standard for Solana, a faithful port of ERC-7540. It replaces atomic deposit/redeem with a **request → fulfill → claim** lifecycle. An operator processes requests asynchronously, enabling strategies that cannot settle instantly: illiquid positions, cross-chain bridges, off-chain asset verification, or workflows requiring human/algorithmic approval.

## How It Differs from SVS-1

| Aspect | SVS-1 (Sync) | SVS-10 (Async) |
|--------|-------------|----------------|
| Deposit flow | Atomic: assets in → shares out (same tx) | request_deposit → fulfill_deposit → claim_deposit |
| Redeem flow | Atomic: shares in → assets out (same tx) | request_redeem → fulfill_redeem → claim_redeem |
| Settlement time | Instant | Operator-dependent (minutes to days) |
| Operator role | None | Processes requests, sets fulfillment price |
| Share price source | Live/stored balance | Oracle (Mode A) or vault-priced (Mode B) at fulfillment |
| Cancellation | N/A | After `cancel_delay` elapses |

## Account Structure

### PDA Derivation

| Account | Seeds | Authority |
|---------|-------|-----------|
| **AsyncVault** | `["async_vault", asset_mint, vault_id.to_le_bytes()]` | User-specified on `initialize` |
| **Shares Mint** | `["shares", vault]` | Vault PDA |
| **Asset Vault** | `["asset_vault", vault]` | Vault PDA |
| **Share Escrow** | `["share_escrow", vault]` | Vault PDA |
| **Deposit Request** | `["deposit_request", vault, owner]` | Owner (closes on claim/cancel) |
| **Redeem Request** | `["redeem_request", vault, owner]` | Owner (closes on claim/cancel) |
| **Claimable Escrow** | `["claimable", vault, owner]` | Vault PDA |
| **Claimable Tokens** | `["claimable_tokens", vault, owner]` | Vault PDA |
| **Operator Approval** | `["operator_approval", vault, owner, operator]` | Owner |
| **Oracle Price** | `["oracle_price", vault]` | Authority-specified |

### State Structs

```rust
#[account]
pub struct AsyncVault {
    pub authority: Pubkey,        // 32 bytes
    pub operator: Pubkey,         // 32 bytes — fulfills requests
    pub asset_mint: Pubkey,       // 32 bytes
    pub shares_mint: Pubkey,      // 32 bytes
    pub asset_vault: Pubkey,      // 32 bytes — shared deposit pool
    pub share_escrow: Pubkey,     // 32 bytes — shared share lock
    pub total_shares: u64,        // 8 bytes
    pub total_assets: u64,        // 8 bytes — updated at fulfillment
    pub decimals_offset: u8,      // 1 byte
    pub bump: u8,                 // 1 byte
    pub paused: bool,             // 1 byte
    pub vault_id: u64,            // 8 bytes
    pub cancel_delay: i64,        // 8 bytes — seconds before cancel allowed
    pub max_staleness: i64,       // 8 bytes — max oracle age (seconds)
    pub _reserved: [u8; 64],      // 64 bytes
}
// Total: 309 bytes

#[account]
pub struct DepositRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub assets_locked: u64,
    pub shares_claimable: u64,    // set at fulfillment (0 while pending)
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub cancel_not_before: i64,
    pub bump: u8,
}

#[account]
pub struct RedeemRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub shares_locked: u64,
    pub assets_claimable: u64,    // set at fulfillment (0 while pending)
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub cancel_not_before: i64,
    pub bump: u8,
}

pub enum RequestStatus { Pending, Fulfilled, Claimed, Cancelled }
```

### One Request Per User Per Vault

PDA seeds `[vault, owner]` enforce this structurally. User must claim/cancel before submitting a new request.

## Instructions

### Core Lifecycle

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize` | `authority` | Create vault, shares mint (Token-2022), asset vault, share escrow |
| `request_deposit` | `user` | Lock assets in asset_vault, create DepositRequest PDA |
| `fulfill_deposit` | `operator` | Compute shares (oracle or vault-priced), set shares_claimable |
| `claim_deposit` | `receiver` | Mint shares to receiver, close DepositRequest PDA |
| `cancel_deposit` | `owner` | Return assets to owner (after cancel_delay), close PDA |
| `request_redeem` | `user` | Lock shares in share_escrow, create RedeemRequest PDA |
| `fulfill_redeem` | `operator` | Compute assets, burn shares, transfer to claimable_tokens |
| `claim_redeem` | `receiver` | Transfer assets from claimable_tokens, close PDA |
| `cancel_redeem` | `owner` | Return shares to owner (after cancel_delay), close PDA |

### Operator & Admin

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `approve_operator` | `owner` | Create OperatorApproval PDA (for delegated claims) |
| `revoke_operator` | `owner` | Close OperatorApproval PDA |
| `pause` / `unpause` | `authority` | Toggle vault pause state |
| `transfer_authority` | `authority` | Transfer vault authority |
| `set_vault_operator` | `authority` | Change vault operator |
| `initialize_oracle` | `authority` | Create OraclePrice PDA |
| `update_oracle_price` | `oracle_authority` | Update oracle price |

### View Functions

| Function | Returns |
|----------|---------|
| `pending_deposit_request` | Assets locked (if status=Pending) |
| `claimable_deposit_request` | Shares claimable (if status=Fulfilled) |
| `pending_redeem_request` | Shares locked (if status=Pending) |
| `claimable_redeem_request` | Assets claimable (if status=Fulfilled) |

## State Machine

```
DepositRequest:  (none) → Pending → Fulfilled → Claimed
                              ↘ Cancelled

RedeemRequest:   (none) → Pending → Fulfilled → Claimed
                              ↘ Cancelled
```

Terminal states (Claimed, Cancelled) close the PDA. Anchor discriminator zeroing prevents revival.

## Pricing Modes

### Mode A: Oracle-Priced (Recommended)

Pass an `OraclePrice` account via `remaining_accounts` during fulfillment. Price read at fulfillment time.

```rust
pub struct OraclePrice {
    pub vault: Pubkey,
    pub price: u64,          // Scaled by PRICE_SCALE (1e9)
    pub updated_at: i64,
    pub authority: Pubkey,
    pub bump: u8,
}
```

- Validated with `svs_oracle::validate_oracle(price, updated_at, now, max_staleness)`
- Deposit: `shares = assets_to_shares(assets_locked, price)`
- Redeem: `assets = shares_to_assets(shares_locked, price)`
- Safer for untrusted operators (price is externally determined)

### Mode B: Vault-Priced (Fallback)

If no oracle account is passed, uses vault internal pricing:

```rust
shares = assets * (total_shares + offset) / (total_assets + offset)
```

- Only safe when operator is fully trusted
- Same virtual offset math as SVS-1/SVS-2

## Math

### Virtual Offset (Inflation Attack Protection)

```rust
decimals_offset = 9 - asset_decimals
offset = 10^decimals_offset
```

### Rounding

All conversions round **in favor of the vault** (Floor for deposits, Floor for redeems). This protects existing shareholders.

## Escrow Design

| Token Type | Storage | Created | Closed |
|-----------|---------|---------|--------|
| Deposited assets | Shared `asset_vault` pool | At vault init | Never |
| Locked shares | Shared `share_escrow` pool | At vault init | Never |
| Claimable assets | Per-user `claimable_tokens` ATA | At `request_redeem` | At `claim_redeem` |

Pre-creating `claimable_tokens` at `request_redeem` saves ~15-20k CU on the operator's `fulfill_redeem` transaction.

## SDK Usage

```typescript
import { AsyncVault } from '@stbr/solana-vault';
import { BN } from '@coral-xyz/anchor';

// Load existing vault
const vault = await AsyncVault.load(program, assetMint, vaultId);

// Deposit lifecycle
await vault.requestDeposit(user, new BN(1_000_000));
await vault.fulfillDeposit(operator, user.publicKey);
await vault.claimDeposit(user, user.publicKey);

// Redeem lifecycle
await vault.requestRedeem(user, new BN(500_000));
await vault.fulfillRedeem(operator, user.publicKey);
await vault.claimRedeem(user, user.publicKey);

// View pending requests
const pending = await vault.pendingDepositRequest(user.publicKey);
const claimable = await vault.claimableDepositRequest(user.publicKey);

// Admin
await vault.pause(authority);
await vault.setVaultOperator(authority, newOperator);
```

## Security

### Cancel Timeout

Every request has `cancel_not_before = requested_at + cancel_delay`. If the operator goes offline, users can cancel after this timestamp to recover their assets/shares. Max cancel delay: 7 days.

### Operator Approval Model

- Separate `approve_operator` (init PDA) and `revoke_operator` (close PDA) instructions
- `OperatorApproval.vault` cross-referenced on every claim — prevents cross-vault attacks
- `OperatorApproval.can_claim` gates claim permissions specifically

### Zero-Address Protection

- `Pubkey::default()` rejected for authority and operator
- Prevents lockout from setting authority to zero address
- Prevents fulfillment check bypass from zero operator

### Pause Enforcement

When `vault.paused = true`:
- All request/fulfill/claim/cancel instructions fail
- View functions still work
- `transfer_authority`, `unpause` still work

### Total Shares Double-Count Prevention

`total_shares` increments at **fulfillment only**. `claim_deposit` mints shares but does NOT increment `total_shares` again. Same pattern for `total_assets`.

## Module Integration

SVS-10 supports optional modules via `--features modules`.

**Build:** `anchor build -p svs-10 -- --features modules`

### Hook Placement (Async-Specific)

| Hook | Placement | Rationale |
|------|-----------|-----------|
| `check_deposit_access` | `request_deposit` + `fulfill_deposit` | User-facing gate AND operator can't bypass |
| `check_deposit_caps` | `fulfill_deposit` | Caps checked against `total_assets` at fulfillment |
| `apply_entry_fee` | `fulfill_deposit` | Fee on shares computed at fulfillment price |
| `check_share_lock` | `request_redeem` | Lock checked when user initiates redemption |
| `apply_exit_fee` | `fulfill_redeem` | Fee on assets computed at fulfillment price |

### Module Admin Instructions (feature-gated)

| Instruction | Purpose |
|-------------|---------|
| `initialize_fee_config` / `update_fee_config` | Entry/exit/management/performance fees |
| `initialize_cap_config` / `update_cap_config` | Global and per-user deposit caps |
| `initialize_lock_config` / `update_lock_config` | Time-locked shares (max 1 year) |
| `initialize_access_config` / `update_access_config` | Whitelist/blacklist with merkle proofs |

## Error Codes

| Code | Name | Message |
|------|------|---------|
| 6000 | `ZeroAmount` | Amount must be greater than zero |
| 6001 | `VaultPaused` | Vault is paused |
| 6002 | `VaultNotPaused` | Vault is not paused |
| 6003 | `InvalidAssetDecimals` | Asset decimals must be <= 9 |
| 6004 | `MathOverflow` | Arithmetic overflow |
| 6005 | `DivisionByZero` | Division by zero |
| 6006 | `Unauthorized` | Unauthorized |
| 6007 | `RequestNotPending` | Request is not in Pending status |
| 6008 | `RequestNotFulfilled` | Request is not in Fulfilled status |
| 6009 | `OperatorNotApproved` | Operator not approved for this action |
| 6010 | `OperatorNotSet` | Vault operator is not set |
| 6011 | `CancelTooEarly` | Cancel delay has not elapsed |
| 6012 | `CancelDelayExceedsMax` | Cancel delay exceeds maximum |
| 6013 | `InsufficientAssets` | Insufficient assets in vault |
| 6014 | `InsufficientShares` | Insufficient shares |
| 6015 | `InvalidOperator` | Invalid operator address |
| 6016 | `InvalidAuthority` | Invalid authority address |
| 6017 | `InvalidCancelDelay` | Invalid cancel delay |
| 6018 | `InvalidMaxStaleness` | Invalid max staleness |
| 6019 | `StaleOraclePrice` | Oracle price is stale |
| 6020 | `InvalidOraclePrice` | Invalid oracle price |
| 6021 | `OracleVaultMismatch` | Oracle vault mismatch |
| 6022 | `GlobalCapExceeded` | Deposit would exceed global vault cap |
| 6023 | `EntryFeeExceedsMax` | Entry fee exceeds maximum |
| 6024 | `LockDurationExceedsMax` | Lock duration exceeds maximum |

## Events

| Event | Fields |
|-------|--------|
| `AsyncVaultInitialized` | vault, authority, asset_mint, shares_mint, vault_id |
| `DepositRequested` | vault, owner, receiver, assets |
| `DepositFulfilled` | vault, owner, assets, shares |
| `DepositClaimed` | vault, owner, receiver, shares |
| `DepositCancelled` | vault, owner, assets_returned |
| `RedeemRequested` | vault, owner, receiver, shares |
| `RedeemFulfilled` | vault, owner, shares, assets |
| `RedeemClaimed` | vault, owner, receiver, assets |
| `RedeemCancelled` | vault, owner, shares_returned |
| `OperatorSet` | vault, owner, operator, can_claim |
| `OperatorRevoked` | vault, owner, operator |
| `VaultStatusChanged` | vault, paused |
| `AuthorityTransferred` | vault, previous_authority, new_authority |
| `VaultOperatorChanged` | vault, previous_operator, new_operator |

## Constants

```rust
pub const ASYNC_VAULT_SEED: &[u8] = b"async_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const ASSET_VAULT_SEED: &[u8] = b"asset_vault";
pub const SHARE_ESCROW_SEED: &[u8] = b"share_escrow";
pub const DEPOSIT_REQUEST_SEED: &[u8] = b"deposit_request";
pub const REDEEM_REQUEST_SEED: &[u8] = b"redeem_request";
pub const CLAIMABLE_SEED: &[u8] = b"claimable";
pub const CLAIMABLE_TOKENS_SEED: &[u8] = b"claimable_tokens";
pub const OPERATOR_APPROVAL_SEED: &[u8] = b"operator_approval";
pub const ORACLE_PRICE_SEED: &[u8] = b"oracle_price";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const DEFAULT_CANCEL_DELAY: i64 = 86400;  // 24 hours
pub const MAX_CANCEL_DELAY: i64 = 604800;     // 7 days
```

## Compute Units

| Instruction | Approximate CU | Notes |
|-------------|---------------|-------|
| `initialize` | ~55,000 | Creates vault + shares mint + asset vault + share escrow |
| `request_deposit` | 22-28k | Transfer + PDA init |
| `fulfill_deposit` | 20-35k | State writes, +10k if oracle |
| `claim_deposit` | 28-35k | mint_to + PDA close |
| `cancel_deposit` | 18-22k | Transfer + PDA close |
| `request_redeem` | 35-42k | Share transfer + PDA init + claimable_tokens init |
| `fulfill_redeem` | 40-55k | Burn + transfer + state writes |
| `claim_redeem` | 35-45k | Transfer + close token account + close PDAs |
| `cancel_redeem` | 25-35k | Share transfer back + close token account + PDA close |

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/svs-10/src/lib.rs` | Program entry point |
| `programs/svs-10/src/state.rs` | Account structs (AsyncVault, DepositRequest, RedeemRequest, etc.) |
| `programs/svs-10/src/constants.rs` | PDA seeds, limits |
| `programs/svs-10/src/error.rs` | Error codes |
| `programs/svs-10/src/events.rs` | Event definitions |
| `programs/svs-10/src/math.rs` | Share/asset conversion (wraps svs-math) |
| `programs/svs-10/src/instructions/` | Instruction handlers |
| `programs/svs-10/src/instructions/admin.rs` | Pause, unpause, transfer authority, set operator, oracle |
| `programs/svs-10/src/instructions/module_admin.rs` | Module config init/update (with `modules` feature) |
| `sdk/core/src/async-vault.ts` | AsyncVault SDK class |
| `sdk/core/src/async-pda.ts` | PDA derivation helpers |

---

**Program ID**: `E6gqyoVDQ33cWFJ9LpdSu68fNw6EKmoKR4db288RpFgJ`
**Specification**: [specs-SVS10.md](specs-SVS10.md)
**Last Updated**: 2026-03-10
