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
    pub operator: Pubkey,               // 32 — vault operator (fulfills requests)
    pub asset_mint: Pubkey,             // 32 — underlying token
    pub shares_mint: Pubkey,            // 32 — LP share token (Token-2022)
    pub asset_vault: Pubkey,            // 32 — ATA holding vault assets
    pub vault_id: u64,                  // 8  — allows multiple vaults per asset
    pub total_assets: u64,              // 8  — AUM (excludes pending deposits)
    pub total_shares: u64,              // 8  — includes reserved-but-unminted shares
    pub total_pending_deposits: u64,    // 8  — isolated pending deposit liquidity
    pub decimals_offset: u8,            // 1  — 9 - asset_decimals
    pub paused: bool,                   // 1
    pub max_staleness: i64,             // 8  — max oracle age in seconds
    pub max_deviation_bps: u16,         // 2  — max oracle vs vault price deviation (default 500 = 5%)
    pub bump: u8,                       // 1  — stored vault PDA bump
    pub share_escrow_bump: u8,          // 1  — stored share escrow PDA bump
    pub _reserved: [u8; 63],            // 63
}

#[account]
pub struct DepositRequest {
    pub owner: Pubkey,                  // 32
    pub receiver: Pubkey,               // 32 — who receives the shares on claim
    pub vault: Pubkey,                  // 32
    pub assets_locked: u64,             // 8  — assets locked by depositor
    pub shares_claimable: u64,          // 8  — computed at fulfill (0 until then)
    pub status: RequestStatus,          // 1  — Pending | Fulfilled
    pub requested_at: i64,              // 8  — unix timestamp of request
    pub fulfilled_at: i64,              // 8  — unix timestamp of fulfillment (0 until then)
    pub bump: u8,                       // 1
}

#[account]
pub struct RedeemRequest {
    pub owner: Pubkey,                  // 32
    pub receiver: Pubkey,               // 32 — who receives the assets on claim
    pub vault: Pubkey,                  // 32
    pub shares_locked: u64,             // 8  — shares locked in escrow
    pub assets_claimable: u64,          // 8  — computed at fulfill (0 until then)
    pub status: RequestStatus,          // 1  — Pending | Fulfilled
    pub requested_at: i64,              // 8  — unix timestamp of request
    pub fulfilled_at: i64,              // 8  — unix timestamp of fulfillment (0 until then)
    pub bump: u8,                       // 1
}

// ClaimableTokens: raw SPL TokenAccount PDA (not a custom struct)
// Seeds: ["claimable_tokens", vault_pubkey, owner_pubkey]
// Authority: Vault PDA. Holds assets between fulfill_redeem and claim_redeem.

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
| `fulfill_deposit` | `vault_operator` or `delegated_operator` | Compute shares via oracle or vault price, move assets into AUM, set status Fulfilled |
| `claim_deposit` | `receiver` or `delegated_operator` | Mint shares via Token-2022 CPI, close DepositRequest PDA |
| `request_redeem` | `owner` | Lock shares in Share Escrow, create pending RedeemRequest |
| `cancel_redeem` | `owner` | Return shares from Share Escrow, close RedeemRequest PDA |
| `fulfill_redeem` | `vault_operator` or `delegated_operator` | Compute assets, burn shares from escrow, transfer assets to ClaimableTokens PDA |
| `claim_redeem` | `receiver` or `delegated_operator` | Transfer assets from ClaimableTokens to receiver, close PDAs |

### Admin Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `pause` | `authority` | Set `paused = true`, disables all user-facing instructions |
| `unpause` | `authority` | Set `paused = false` |
| `transfer_authority` | `authority` | Transfer vault authority to new pubkey |
| `set_vault_operator` | `authority` | Set or replace vault operator |
| `set_operator` | `owner` | Delegate granular permissions to an operator (fulfill_deposit, fulfill_redeem, claim) |

### View Instructions

On-chain instructions that use `set_return_data()` for CPI composability. For direct access, read request account state via `program.account.depositRequest.fetch()` or equivalent.

| Instruction | Returns |
|-------------|---------|
| `pending_deposit_request` | Assets in pending DepositRequest for owner |
| `claimable_deposit_request` | Shares in fulfilled DepositRequest ready to claim |
| `pending_redeem_request` | Shares in pending RedeemRequest for owner |
| `claimable_redeem_request` | Assets in ClaimableTokens account for owner |

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

// Read request state from on-chain accounts
const depositRequest = await vault.fetchDepositRequest(user.publicKey);
const redeemRequest = await vault.fetchRedeemRequest(user.publicKey);

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
- Operator fulfill instructions also fail (`fulfill_deposit`, `fulfill_redeem`)
- Admin instructions still work (`unpause`, `transfer_authority`, `set_vault_operator`)
- View instructions still work

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

**Example Vault**: [`7jaQ3FrdELsKq2A23LRNtGUFwSgkrhCnJ8bE2F8BMQMf`](https://explorer.solana.com/address/7jaQ3FrdELsKq2A23LRNtGUFwSgkrhCnJ8bE2F8BMQMf?cluster=devnet)

#### Example Transactions (All Instructions)

| Step | Transaction |
|------|-------------|
| Initialize vault | [`4KaJXA...`](https://explorer.solana.com/tx/4KaJXAVW2JhmDoSM1hYDTmGHpP1UNUe94FKNjDD78CNG5eMZS4qnBNZTScrVB4hmZjgjZBcFbLWd8HSBDQgQX2WL?cluster=devnet) |
| Request deposit | [`fFD8gw...`](https://explorer.solana.com/tx/fFD8gwmW5hgdf552TqcVSP91bKXy7EqiNajLn9ezTxudr7kyBbu8d5nTHiRXhoVtzhw9L6CjSQKHpXPYnJHkzDm?cluster=devnet) |
| Fulfill deposit | [`4zF3t8...`](https://explorer.solana.com/tx/4zF3t8rzxVbY5NJJR3iphf33vKe64yfSFgoCdMWLU8XaUn21PvL3KfaMPg2Ev9nS3tWYRCed83qztv9YL6uTm4XA?cluster=devnet) |
| Claim deposit | [`459gq9...`](https://explorer.solana.com/tx/459gq98E3oafRTz9EjpuZF7gb9zvNkzRkvMrrZDnPkXaVqj3G9CuongWpp4HfjenuGCaZVo3Yre8pEb1dRUFFrF?cluster=devnet) |
| Request redeem | [`QMHN2R...`](https://explorer.solana.com/tx/QMHN2RsW7NWK5q6fXCCcyCDG9ArxJM9H5zYhDjDMDakw9xfEkwzvaNtJ7Vn9o3XJxbuCmyB1hMmX8os5hpoD5QV?cluster=devnet) |
| Fulfill redeem | [`m8rK77...`](https://explorer.solana.com/tx/m8rK77e9FLgYxPn67NuJdfG5izKZUViTF6U5pf7TfKzprUjGPyBzhjNvGpGN7rqF8JuC6iCbL5hjXnwYPeoi8WQ?cluster=devnet) |
| Claim redeem | [`41EpHh...`](https://explorer.solana.com/tx/41EpHhgNJXtFxtK2Wdmbeu7dCjYLABNXUAGaKA8VemYQMS5bh4f3scBQREJkav8KDozcyg8CdmSDtauXmsacMda8?cluster=devnet) |
| Cancel deposit | [`63Brg7...`](https://explorer.solana.com/tx/63Brg73NMZ91NQy3zAHXFGbBYdHSY2bD1a3aznUGXhuxN5H7AkAUcQiuEdn4ZiMMs7RUUc45Y3EfRdjy9Kxd8jgF?cluster=devnet) |
| Cancel redeem | [`3EWDsA...`](https://explorer.solana.com/tx/3EWDsALBZEueaFhhqPxcSg5xmdnVS5YJrs3EigbrSA8Qejz8NYoHFNjceQk4NDAD9FSjyhMM4VytngVuK6Ue85q9?cluster=devnet) |
| Set operator (approve) | [`2NW9ue...`](https://explorer.solana.com/tx/2NW9uefmQrWRUsKfwfmrMmNPL8YkxZTaGb45UNinxQk8QpKGAGDbj4HcqiSDUCt7tsXhWgC8Uz1UnQS9hUjcxjUw?cluster=devnet) |
| Set operator (revoke) | [`332Wmt...`](https://explorer.solana.com/tx/332Wmtu8jyzQmeqWoD3aAM1gPBbmCNvDMgtEaNLcQDB6TpKWQypRYqR4B52PGsjy561koaVJJ8Z6pS42smaLGDdE?cluster=devnet) |
| Set vault operator | [`DPzBc9...`](https://explorer.solana.com/tx/DPzBc9in8mSayhWZ596TpCddtXQHXkggTmbqmMoUBbGzGUTdmMmJckJGn2sWvQ9P9Kt43U2cuRHjahgYZxhEt2u?cluster=devnet) |
| Transfer authority | [`5SjGuD...`](https://explorer.solana.com/tx/5SjGuDicMQZuheWE3EgynY7hTJueMtNJMJZLZeYRKmrxnNsCvSbuQXyFKs94anGMbujkyUYMjrxf4NLbZJc5fRBP?cluster=devnet) |
| Pause vault | [`HG9PLc...`](https://explorer.solana.com/tx/HG9PLcec3xPpr6T99mjYSaMXL9bFT9iVVPVcVgXSB3ZmHTpkdM2h5BWqaBGMAQ8Zzd9Nv82938GEzk112JURvnQ?cluster=devnet) |
| Unpause vault | [`2cxipo...`](https://explorer.solana.com/tx/2cxipok1Nqk6hNoAodVGJGbavEJ3TeKY6cjNSBXbkRt2R9E53jhA8YqJS9QQA1NtfxcSfKBdzujedF8MWxmUzZmu?cluster=devnet) |

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
| 6002 | `InvalidAssetDecimals` | Asset decimals must be <= 9 |
| 6003 | `MathOverflow` | Arithmetic overflow |
| 6004 | `DivisionByZero` | Division by zero |
| 6005 | `Unauthorized` | Unauthorized - caller is not vault authority |
| 6006 | `DepositTooSmall` | Deposit amount below minimum threshold |
| 6007 | `VaultNotPaused` | Vault is not paused |
| 6008 | `RequestNotPending` | Request is not in pending status |
| 6009 | `RequestNotFulfilled` | Request is not in fulfilled status |
| 6010 | `OperatorNotApproved` | Operator not approved for this action |
| 6011 | `OracleStale` | Oracle price data is stale |
| 6012 | `InsufficientLiquidity` | Insufficient liquidity in vault |
| 6013 | `OracleDeviationExceeded` | Oracle price deviation exceeds maximum |
| 6014 | `InvalidRequestOwner` | Caller is not the request owner |
| 6015 | `GlobalCapExceeded` | Deposit would exceed global vault cap |
| 6016 | `EntryFeeExceedsMax` | Entry fee exceeds maximum |
| 6017 | `LockDurationExceedsMax` | Lock duration exceeds maximum |
| 6018 | `InvalidAddress` | Invalid address: cannot be the zero address |

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
