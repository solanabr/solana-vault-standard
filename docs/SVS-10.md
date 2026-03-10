# SVS-10: Async Vault

## Overview

SVS-10 is the asynchronous tokenized vault variant in the Solana Vault Standard, equivalent to ERC-7540 on EVM. Unlike synchronous vaults (SVS-1 through SVS-4), deposits and redemptions follow a three-phase request → fulfill → claim lifecycle. This allows an operator to process requests off-hours, apply external pricing (oracle NAV), or manage illiquid positions before committing shares or assets.

**Program ID**: `CpjFjyxRwTGYxR6JWXpfQ1923z5wVwpyBvgPFjm9jamJ`

**Use cases**: RWA tokenization, cross-chain strategies, institutional fund management, illiquid asset vaults.

## Balance Model

**Stored Balance**: `total_assets` and `total_shares` are tracked on-chain in the vault state.

- `total_assets` — assets under management (excludes pending deposits)
- `total_shares` — shares outstanding, including reserved-but-unminted shares between fulfill and claim
- `total_pending_deposits` — assets locked in pending deposit requests, isolated from vault AUM

```rust
pub fn get_total_assets(vault: &AsyncVault) -> u64 {
    vault.total_assets  // Does NOT include pending deposit assets
}
```

The `total_pending_deposits` field ensures that assets waiting in deposit requests do not inflate the share price before they are accepted into the vault by the operator.

## Account Structure

### PDA Derivation

| Account | Seeds | Authority |
|---------|-------|-----------|
| Vault | `["vault", asset_mint, vault_id.to_le_bytes()]` | User-specified on `initialize` |
| Shares Mint | `["shares", vault_pubkey]` | Vault PDA |
| Asset Vault | ATA of `asset_mint` for Vault PDA | Vault PDA |
| Share Escrow | `["share_escrow", vault_pubkey]` | Vault PDA |
| Deposit Request | `["deposit_request", vault_pubkey, owner_pubkey]` | Program |
| Redeem Request | `["redeem_request", vault_pubkey, owner_pubkey]` | Program |
| Claimable Tokens | `["claimable_tokens", vault_pubkey, owner_pubkey]` | Vault PDA |
| Operator Approval | `["operator_approval", vault_pubkey, owner_pubkey, operator_pubkey]` | Program |

### State Structs

```rust
#[account]
pub struct AsyncVault {
    pub authority: Pubkey,              // 32 — admin (pause/unpause/transfer)
    pub operator: Pubkey,               // 32 — fulfills requests
    pub asset_mint: Pubkey,             // 32 — underlying token
    pub shares_mint: Pubkey,            // 32 — LP share token (Token-2022)
    pub asset_vault: Pubkey,            // 32 — ATA holding vault assets
    pub vault_id: u64,                  // 8  — allows multiple vaults per asset
    pub total_assets: u64,              // 8  — AUM (excludes pending deposits)
    pub total_shares: u64,              // 8  — includes reserved-but-unminted shares
    pub total_pending_deposits: u64,    // 8  — isolated pending deposit liquidity
    pub decimals_offset: u8,            // 1  — 9 - asset_decimals
    pub paused: bool,                   // 1
    pub max_staleness: u64,             // 8  — max oracle age in seconds
    pub max_deviation_bps: u16,         // 2  — max oracle vs vault price deviation (default 500 = 5%)
    pub bump: u8,                       // 1  — stored PDA bump
    pub _reserved: [u8; 64],            // 64
}

#[account]
pub struct DepositRequest {
    pub vault: Pubkey,                  // 32
    pub owner: Pubkey,                  // 32
    pub assets: u64,                    // 8  — assets locked
    pub shares: u64,                    // 8  — computed at fulfill (0 until then)
    pub status: RequestStatus,          // 1  — Pending | Fulfilled
    pub bump: u8,                       // 1
}

#[account]
pub struct RedeemRequest {
    pub vault: Pubkey,                  // 32
    pub owner: Pubkey,                  // 32
    pub shares: u64,                    // 8  — shares locked in escrow
    pub assets: u64,                    // 8  — computed at fulfill (0 until then)
    pub status: RequestStatus,          // 1  — Pending | Fulfilled
    pub bump: u8,                       // 1
}

#[account]
pub struct ClaimableTokens {
    pub vault: Pubkey,                  // 32
    pub owner: Pubkey,                  // 32
    pub assets: u64,                    // 8  — assets available to claim
    pub bump: u8,                       // 1
}

#[account]
pub struct OperatorApproval {
    pub owner: Pubkey,                  // 32
    pub operator: Pubkey,               // 32
    pub vault: Pubkey,                  // 32
    pub can_fulfill_deposit: bool,      // 1
    pub can_fulfill_redeem: bool,       // 1
    pub can_claim: bool,                // 1
    pub bump: u8,                       // 1
}

pub enum RequestStatus {
    Pending,
    Fulfilled,
}
```

## Instructions

### Lifecycle Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize` | `payer` | Create vault, shares mint (Token-2022), asset vault ATA, share escrow |
| `request_deposit` | `owner` | Lock assets, create pending DepositRequest, increment `total_pending_deposits` |
| `cancel_deposit` | `owner` | Return assets to owner, close DepositRequest PDA (synchronous, ERC-7887 deviation) |
| `fulfill_deposit` | `operator` | Compute shares via oracle or vault price, move assets into AUM, set status Fulfilled |
| `claim_deposit` | `receiver` or `operator` | Mint shares via Token-2022 CPI, close DepositRequest PDA |
| `request_redeem` | `owner` | Lock shares in Share Escrow, create pending RedeemRequest |
| `cancel_redeem` | `owner` | Return shares from Share Escrow, close RedeemRequest PDA |
| `fulfill_redeem` | `operator` | Compute assets, burn shares from escrow, transfer assets to ClaimableTokens PDA |
| `claim_redeem` | `receiver` or `operator` | Transfer assets from ClaimableTokens to receiver, close PDAs |

### Admin Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `pause` | `authority` | Set `paused = true`, disables all user-facing instructions |
| `unpause` | `authority` | Set `paused = false` |
| `transfer_authority` | `authority` | Transfer vault authority to new pubkey |
| `set_vault_operator` | `authority` | Set or replace vault operator |
| `set_operator` | `owner` | Delegate granular permissions to an operator (fulfill_deposit, fulfill_redeem, claim) |

### View Functions

All view functions use `set_return_data()` for CPI composability.

| Function | Returns |
|----------|---------|
| `pending_deposit_request` | Assets in pending DepositRequest for owner |
| `claimable_deposit_request` | Shares in fulfilled DepositRequest ready to claim |
| `pending_redeem_request` | Shares in pending RedeemRequest for owner |
| `claimable_redeem_request` | Assets in ClaimableTokens for owner |

### Deposit Lifecycle Detail

```
User                    Operator                Program
  |                         |                      |
  |-- request_deposit ----->|                      |
  |   (lock assets)         |                      |
  |                         |-- fulfill_deposit -->|
  |                         |   (set price,        |
  |                         |    assets → AUM)     |
  |-- claim_deposit ------->|                      |
  |   (receive shares)      |                      |
```

### Redeem Lifecycle Detail

```
User                    Operator                Program
  |                         |                      |
  |-- request_redeem ------>|                      |
  |   (lock shares)         |                      |
  |                         |-- fulfill_redeem --->|
  |                         |   (set price,        |
  |                         |    burn shares,      |
  |                         |    escrow assets)    |
  |-- claim_redeem -------->|                      |
  |   (receive assets)      |                      |
```

## Oracle Integration

SVS-10 supports dual pricing: vault-priced (using on-chain `total_assets` / `total_shares`) or oracle-priced (using an externally provided NAV).

### Oracle Parameter

The `oracle_price: Option<u64>` parameter on `fulfill_deposit` and `fulfill_redeem` controls which pricing mode is used:

```rust
// Vault-priced: operator passes None, uses on-chain ratio
fulfill_deposit(oracle_price: None, ...)

// Oracle-priced: operator passes current NAV per share
fulfill_deposit(oracle_price: Some(1_050_000), ...)  // e.g., $1.05 per share
```

### Deviation Protection

When `oracle_price` is provided, the program validates it against the current vault price:

```rust
let vault_price = total_assets / total_shares;
let deviation = abs(oracle_price - vault_price) * 10_000 / vault_price;
require!(deviation <= vault.max_deviation_bps, VaultError::OracleDeviationExceeded);
```

**Default**: `max_deviation_bps = 500` (5%). Configurable per vault.

### Empty Vault Edge Case

When `total_assets == 0 && total_shares == 0`, the deviation check is skipped entirely. There is no reference price to compare against, so any oracle price is accepted for the first fulfillment.

## Module Compatibility

SVS-10 supports all four optional modules. Hooks are called at different lifecycle phases compared to synchronous vaults:

| Module | Hook Point | Instruction |
|--------|-----------|-------------|
| svs-fees | Entry fee deducted from assets | `fulfill_deposit` |
| svs-fees | Exit fee deducted from assets | `fulfill_redeem` |
| svs-caps | Global/per-user cap check | `request_deposit` |
| svs-locks | Lock set after shares received | `claim_deposit` |
| svs-locks | Lock check before shares escrowed | `request_redeem` |
| svs-access | Whitelist/blacklist check | `request_deposit`, `request_redeem` |
| svs-access | Re-check at fulfillment time | `fulfill_deposit`, `fulfill_redeem` |

**Access re-check on fulfill**: Since time may pass between request and fulfillment, access is re-validated at `fulfill_deposit` / `fulfill_redeem` to handle cases where a user's access is revoked after they submitted a request.

Module config PDAs are passed via `remaining_accounts`. If not provided, checks are skipped (pure async vault behavior).

See [specs-modules.md](specs-modules.md) for full module specifications.

## SDK Usage

```typescript
import { AsyncVault } from "@stbr/solana-vault";
import { BN } from "@coral-xyz/anchor";

// Load existing vault
const vault = await AsyncVault.load(program, assetMint, 1);

// User: request deposit
await vault.requestDeposit(user, { assets: new BN(1_000_000) });

// Operator: fulfill deposit (vault-priced)
await vault.fulfillDeposit(operator, { owner: user.publicKey });

// Operator: fulfill deposit (oracle-priced, $1.05/share)
await vault.fulfillDeposit(operator, {
  owner: user.publicKey,
  oraclePrice: new BN(1_050_000),
});

// User: claim deposit shares
await vault.claimDeposit(user, { owner: user.publicKey, receiver: user.publicKey });

// User: request redeem
const shares = await vault.getShareBalance(user.publicKey);
await vault.requestRedeem(user, { shares });

// Operator: fulfill redeem
await vault.fulfillRedeem(operator, { owner: user.publicKey });

// User: claim redeemed assets
await vault.claimRedeem(user, { owner: user.publicKey, receiver: user.publicKey });

// View pending/claimable state
const pendingDeposit = await vault.pendingDepositRequest(user.publicKey);
const claimableDeposit = await vault.claimableDepositRequest(user.publicKey);
const pendingRedeem = await vault.pendingRedeemRequest(user.publicKey);
const claimableRedeem = await vault.claimableRedeemRequest(user.publicKey);

// Delegate granular permissions to operator
await vault.setOperator(user, {
  operator: operator.publicKey,
  canFulfillDeposit: true,
  canFulfillRedeem: true,
  canClaim: true,
});
```

## Security

### Inflation Attack Protection

SVS-10 uses the same virtual offset mechanism as SVS-1 through SVS-4:

```rust
offset = 10^(9 - asset_decimals)
shares = assets * (total_shares + offset) / (total_assets + 1)
```

### Liquidity Isolation

`total_pending_deposits` is tracked separately from `total_assets`. Assets in pending deposit requests do not affect the current share price, preventing requests from diluting or inflating share value before the operator accepts them into AUM.

### Rounding

All conversions round in favor of the vault:
- `fulfill_deposit`: shares computed with floor rounding (user gets fewer shares)
- `fulfill_redeem`: assets computed with floor rounding (user gets fewer assets)

### Operator Trust Model

The operator role is semi-trusted:
- Operator can fulfill requests at a price within `max_deviation_bps` of the vault price
- Operator cannot exceed the deviation limit without authority action to reconfigure
- Operator cannot drain the vault — `fulfill_redeem` only burns escrowed shares and transfers from vault AUM
- Authority can replace operator at any time via `set_vault_operator`

### Pause Mechanism

When `vault.paused = true`:
- All user-facing instructions fail (`request_deposit`, `cancel_deposit`, `claim_deposit`, `request_redeem`, `cancel_redeem`, `claim_redeem`)
- Operator fulfill instructions also fail
- View functions and `transfer_authority` still work

## Design Decisions

### Synchronous Cancel (ERC-7887 Deviation)

ERC-7540 specifies that cancel requests may also be asynchronous (requiring operator action). SVS-10 deviates from this — cancels are synchronous. The owner can cancel a pending request at any time and immediately recover their assets or shares. This simplifies the lifecycle and reduces the number of on-chain states to track.

This aligns with the ERC-7887 extension (synchronous cancel), which is treated as a design baseline rather than an optional add-on.

### Stored Balance with Pending Isolation

Rather than a live balance model, SVS-10 uses stored `total_assets` and `total_shares`. This is necessary because assets move through multiple on-chain PDAs during the lifecycle (pending deposit, vault ATA, claimable tokens). A live balance read would be ambiguous across these accounts.

`total_pending_deposits` isolates assets that have been submitted but not yet accepted. These assets sit in the vault's asset token account but must not be included in share price calculations until `fulfill_deposit` transitions them into AUM.

### total_shares Includes Reserved Shares

Between `fulfill_deposit` and `claim_deposit`, the operator has computed and reserved a share amount for the depositor. These reserved shares are included in `total_shares` immediately at `fulfill_deposit` (before the user claims them via mint). This prevents the share price from drifting between fulfillment and claim.

## Deployment

### Devnet

**Program ID**: `CpjFjyxRwTGYxR6JWXpfQ1923z5wVwpyBvgPFjm9jamJ`

**Example Vault**: [`6GtJk7GoexcfMVL6bJqEmN5fUB5MBrx59N6VVyEC7Jgd`](https://explorer.solana.com/address/6GtJk7GoexcfMVL6bJqEmN5fUB5MBrx59N6VVyEC7Jgd?cluster=devnet)

#### Example Transactions (All Instructions)

| Step | Transaction |
|------|-------------|
| Initialize vault | [`56NWB6...`](https://explorer.solana.com/tx/56NWB62ceGDsT1w3L5eHaZ5V9HeeYPLdG5ny84G3k8sj7GJcneVByiQ6VL2d8f3vmkoUyPBRFz2qG6wan5G58DYS?cluster=devnet) |
| Request deposit | [`NszGH3...`](https://explorer.solana.com/tx/NszGH3tCj4xwxGZRygzofvGKDrj9onmqZL4nc4bVsXczf9xqYqwgsBDWp35zgRU5MoqJi3U5G8DEcgXqFUSNoUx?cluster=devnet) |
| Fulfill deposit | [`57kb9u...`](https://explorer.solana.com/tx/57kb9usH85TakzEuQWu6mbh2SxDxitrFeohihcYepDUBDqfzZvwi8zC3wCAoYQVdCdgcVWFJWVS3vKhEnT4V2rs8?cluster=devnet) |
| Claim deposit | [`4HnyVd...`](https://explorer.solana.com/tx/4HnyVdm2yfRyEvBhHrU2myzqmaUWHCP4bNeappmCg3QPdnGXveH7kwoUj1TxzKiXXucACqFE4X1da2wfZfixX5vt?cluster=devnet) |
| Request redeem | [`2FFvD8...`](https://explorer.solana.com/tx/2FFvD8tENH9wfoSaab4H2UZccHqgzatjRGfukp6YXHf7RGsaPWWW1ukxp9KSwFzkRrXWpaVzQh5bQ5TqwyNoLwe?cluster=devnet) |
| Fulfill redeem | [`TfLxVe...`](https://explorer.solana.com/tx/TfLxVeLRuMegCcBA8k3QQLHT236vQM7t5xmp2K7RVhMUcxyoqZZGC9oTrcM8uc5P8TudYvL8duWMeMKM6Dk8cVz?cluster=devnet) |
| Claim redeem | [`51hrrD...`](https://explorer.solana.com/tx/51hrrDukbhBbWeW7uXxQptJFYKmVeKjHcQher12ZQ2qKXUDzMVbZp3bRDRPNf6rGtdhg2eR9wTL7eHEGyamGZcZr?cluster=devnet) |
| Cancel deposit | [`5jN1Gc...`](https://explorer.solana.com/tx/5jN1Gc2JYwQ1Qfa3mmD55xQWAt13nHszr3VuEcNsS2nnr1YZ3NA3vHuUpdbWGiruxriHzwvrFAuVXfXo1jLjYFPv?cluster=devnet) |
| Cancel redeem | [`2LUgQ8...`](https://explorer.solana.com/tx/2LUgQ8FuUXytd4GGmtYN6drCrbwsyvA6MiCFH5ajBrmSvri6G6tKz7bL3wR8Jc6H6uU2VuvGDDqJ3KVWPUThaFZi?cluster=devnet) |
| Set operator (approve) | [`34xWhb...`](https://explorer.solana.com/tx/34xWhbtPMMHpdigMWn5rb9th5tiA9VuKSsDDTPRHBLe7wK5yFQz7NiNxBFza1NfTPahsAj2v56aKstjgSyDcfcur?cluster=devnet) |
| Set operator (revoke) | [`4MfRat...`](https://explorer.solana.com/tx/4MfRatMo1rCZqqqKaUnb49TxMVPHxQx3ejbqpePCNypySSWDbKe1FoEdrfhkAeuTdiUQ2JUw5Qug9VKneVCgGvLZ?cluster=devnet) |
| Set vault operator | [`LAhujY...`](https://explorer.solana.com/tx/LAhujY3FtdjbpRJfRqgDHtzVwtU21fy9VYZZKzfoKU8TPxFMF6jfRDyE9PJaCVshuYW6StTbbWGf7VY92fvEAG5?cluster=devnet) |
| Transfer authority | [`2urexP...`](https://explorer.solana.com/tx/2urexPQaBvMFxkFy8iRb5qoCDJH8FXeUpfP1u7z51d3BJc3nBQpd4kBiL4aiUSZFbQLHRe5pvGUeKWdFNDJZ39Lk?cluster=devnet) |
| Pause vault | [`zg75UB...`](https://explorer.solana.com/tx/zg75UBU9T1xqQsEkMmhGyiDBJGGB7Rn4SZVXVzUXRv1PnuaDEHPfDrpYM4qWNAVfA9pyZANe8eT4k6GNm8QX15Z?cluster=devnet) |
| Unpause vault | [`3WiAHu...`](https://explorer.solana.com/tx/3WiAHue1jjD3gZBzqWrbQxUcmtFmBvvqkFMRomoniqvPzWnE2wMgjdBw2TbJhmHaA5FdSHosAZh6udweWwspCcrQ?cluster=devnet) |

Run the full lifecycle yourself:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-node scripts/e2e-svs10-devnet.ts
```

### Mainnet

**Checklist**:
- [ ] Verifiable build (`anchor build --verifiable`)
- [ ] Devnet testing (7+ days)
- [ ] Security audit
- [ ] Fuzz testing (10+ min)
- [ ] Oracle deviation scenarios tested
- [ ] Operator key secured (multisig recommended)
- [ ] User explicit confirmation

## Error Codes

| Code | Name | Message |
|------|------|---------|
| 6000 | `ZeroAmount` | Amount must be greater than zero |
| 6001 | `VaultPaused` | Vault is paused |
| 6002 | `Unauthorized` | Unauthorized |
| 6003 | `InvalidStatus` | Request is not in the expected status |
| 6004 | `RequestAlreadyExists` | A request already exists for this owner |
| 6005 | `NoRequestFound` | No request found for this owner |
| 6006 | `OracleDeviationExceeded` | Oracle price deviates too far from vault price |
| 6007 | `OracleStaleness` | Oracle price exceeds max staleness |
| 6008 | `MathOverflow` | Arithmetic overflow |
| 6009 | `InsufficientShares` | Insufficient shares balance |
| 6010 | `InsufficientAssets` | Insufficient assets in vault |
| 6011 | `InvalidAssetDecimals` | Asset decimals must be <= 9 |
| 6012 | `VaultNotPaused` | Vault is not paused |

## Differences from Synchronous Variants

| Feature | SVS-1/SVS-2 | SVS-10 (Async) |
|---------|-------------|-----------------|
| **Deposit Settlement** | Immediate | request → fulfill → claim |
| **Redeem Settlement** | Immediate | request → fulfill → claim |
| **Pricing** | On-chain ratio | Vault ratio or oracle NAV |
| **Operator Role** | None | Required for fulfillment |
| **Cancellation** | N/A | Synchronous (ERC-7887) |
| **Pending State** | No | DepositRequest, RedeemRequest PDAs |
| **Escrow** | No | Share Escrow, ClaimableTokens PDAs |
| **Use Case** | Liquid assets in vault | Illiquid or externally managed assets |

---

**Specification Version**: 1.0.0
**Last Updated**: 2026-03-10
**Program Version**: 0.1.0
**ERC Reference**: [ERC-7540](https://eips.ethereum.org/EIPS/eip-7540), [ERC-7887](https://eips.ethereum.org/EIPS/eip-7887)
