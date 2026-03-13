# SVS-10: Async Vault (ERC-7540)

## Overview

SVS-10 is the asynchronous vault variant of the Solana Vault Standard. Instead of settling deposits and redemptions in a single instruction, it uses a three-step lifecycle:

1. `request`
2. `fulfill`
3. `claim`

This matches the intent of ERC-7540 while preserving Solana-native safety properties: explicit escrow accounts, canonical PDA validation, stored economic accounting, and operator-gated settlement with optional oracle pricing.

SVS-10 is the right fit when share pricing cannot be finalized at request time, for example:
- off-chain NAV computation
- delayed settlement windows
- credit or underwriting workflows
- batch valuation
- settlement that depends on operator approval or oracle freshness

Unlike SVS-1 and SVS-2, SVS-10 does not expose synchronous `deposit/mint/withdraw/redeem` user flows. The price that matters is the price at `fulfill_*`, not at `request_*`.

## Relationship to Other Variants

| Feature | SVS-1 | SVS-2 | SVS-10 |
|---------|-------|-------|--------|
| Deposit settlement | Immediate | Immediate | Async |
| Redeem settlement | Immediate | Immediate | Async |
| `total_assets` model | Live vault balance | Stored balance | Stored balance |
| Share issuance | Immediate mint | Immediate mint | Fulfilled, then claimed |
| Redemption payout | Immediate transfer | Immediate transfer | Fulfilled to escrow, then claimed |
| Operator role | No | Optional admin only | Required for `fulfill_*` |
| Oracle use | Optional off-chain preview only | Optional off-chain preview only | Optional on-chain settlement input |

## Why the Async Model Exists

The key architectural decision in SVS-10 is separating user intent from economic settlement.

- `request_deposit` proves intent and escrows assets.
- `fulfill_deposit` decides how many shares are economically owed.
- `claim_deposit` converts that entitlement into minted shares.

The redeem path mirrors this:

- `request_redeem` escrows shares.
- `fulfill_redeem` burns shares and escrows claimable assets.
- `claim_redeem` transfers assets to the receiver.

This avoids pretending the vault knows final pricing at request time. It also removes a large class of unsafe “preview implies settlement” assumptions that are fine in synchronous ERC-4626 style vaults but wrong in async products.

## State Machine

### Deposit Request

```text
Pending -> Fulfilled -> Claimed
Pending -> Cancelled
```

### Redeem Request

```text
Pending -> Fulfilled -> Claimed
Pending -> Cancelled
```

### Operational Meaning

- `Pending`: user assets or shares are escrowed, but no economic settlement has happened yet
- `Fulfilled`: settlement is fixed and claimable
- `Claimed`: entitlement has been consumed
- `Cancelled`: escrow was returned to the owner

Only `Pending -> Fulfilled|Cancelled` and `Fulfilled -> Claimed` are valid transitions.

## Account Model

### PDA Layout

| Account | Seeds | Purpose |
|---------|-------|---------|
| `AsyncVault` | `["async_vault", asset_mint, vault_id.to_le_bytes()]` | Core async vault state |
| `Shares Mint` | `["shares", vault_pubkey]` | Token-2022 shares mint |
| `Share Escrow` | `["share_escrow", vault_pubkey]` | Holds shares locked for pending redeems |
| `DepositRequest` | `["deposit_request", vault_pubkey, owner_pubkey]` | One active deposit request per owner |
| `RedeemRequest` | `["redeem_request", vault_pubkey, owner_pubkey]` | One active redeem request per owner |
| `ClaimableEscrow` | `["claimable", vault_pubkey, owner_pubkey]` | Holds assets claimable after redeem fulfillment |
| `OperatorApproval` | `["operator_approval", vault_pubkey, owner_pubkey, operator_pubkey]` | Delegated claim authorization |

### Token Accounts

| Account | Type | Notes |
|---------|------|-------|
| `asset_vault` | ATA of `(asset_mint, vault)` | Holds active assets plus pending deposit escrows |
| `share_escrow` | PDA-owned token account | Holds shares locked by pending redeem requests |
| `claimable_tokens` | ATA of `(asset_mint, claimable_escrow)` | Holds assets reserved for fulfilled redeems |

## Core State

### `AsyncVault`

The vault stores both settled and in-flight economic aggregates:

```rust
pub struct AsyncVault {
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub share_escrow: Pubkey,
    pub total_assets: u64,
    pub total_shares: u64,
    pub pending_deposit_assets: u64,
    pub pending_claim_shares: u64,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub max_staleness: i64,
    pub request_expiry_secs: i64,
    pub _reserved: [u8; 64],
}
```

The two fields that make the async accounting work are:

- `pending_deposit_assets`: assets already transferred into the vault ATA but not yet recognized as settled AUM
- `pending_claim_shares`: shares already economically issued by `fulfill_deposit` but not yet minted on-chain to the receiver

Without those two aggregates, the vault cannot preserve conservation across request, fulfill, and claim.

### `DepositRequest`

```rust
pub struct DepositRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub assets_locked: u64,
    pub shares_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub bump: u8,
}
```

### `RedeemRequest`

```rust
pub struct RedeemRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub shares_locked: u64,
    pub assets_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub bump: u8,
}
```

### `ClaimableEscrow`

```rust
pub struct ClaimableEscrow {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub bump: u8,
}
```

### `OperatorApproval`

```rust
pub struct OperatorApproval {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub approved: bool,
    pub bump: u8,
}
```

This approval is intentionally narrow. It delegates claim authority only. Settlement remains restricted to the vault-level `operator`.

## Instruction Set

| Instruction | Purpose | Access Control |
|-------------|---------|----------------|
| `initialize` | Create async vault, shares mint, asset vault, share escrow | Authority signer |
| `request_deposit` | Lock assets and open deposit request | User signer |
| `cancel_deposit` | Return locked assets and close pending request | Request owner |
| `fulfill_deposit` | Convert locked assets into claimable shares | Vault operator |
| `claim_deposit` | Mint fulfilled shares to receiver | Owner, receiver, or approved operator |
| `request_redeem` | Lock shares and open redeem request | User signer |
| `cancel_redeem` | Return locked shares and close pending request | Request owner |
| `fulfill_redeem` | Burn escrowed shares and reserve claimable assets | Vault operator |
| `claim_redeem` | Transfer reserved assets to receiver | Owner, receiver, or approved operator |
| `set_operator` | Approve or revoke delegated claim operator | Owner signer |
| `pause` | Pause requests and fulfills | Vault authority |
| `unpause` | Resume requests and fulfills | Vault authority |
| `transfer_authority` | Transfer vault admin role | Vault authority |
| `set_vault_operator` | Change fulfill operator | Vault authority |

## Fulfillment Pricing

SVS-10 supports two settlement modes:

### 1. Vault-Priced Fulfillment

If no oracle accounts are passed, fulfillment uses the vault’s stored accounting:

- deposits: `convert_to_shares(..., Rounding::Floor)`
- redeems: `convert_to_assets(..., Rounding::Floor)`

This keeps rounding vault-favoring.

### 2. Oracle-Priced Fulfillment

If `oracle_account` and `oracle_program` are passed to `fulfill_*`, the program:

- verifies `oracle_account.owner == oracle_program`
- deserializes `price_per_share` and `updated_at`
- validates non-zero price
- validates freshness against `vault.max_staleness`

This design is safer than reading arbitrary CPI return data. The program validates account ownership directly and rejects stale or malformed oracle input.

## Request Lifecycle

### Deposit Path

#### `request_deposit`

- transfers assets from user ATA into `asset_vault`
- creates `DepositRequest`
- increments `pending_deposit_assets`
- does not touch `total_assets`
- does not touch `total_shares`

#### `fulfill_deposit`

- requires request status = `Pending`
- requires request age <= `request_expiry_secs`
- optionally uses oracle pricing
- applies entry fee when module hooks are enabled
- writes `shares_claimable`
- moves request to `Fulfilled`
- decrements `pending_deposit_assets`
- increments `pending_claim_shares`
- increments `total_assets`
- increments `total_shares`

#### `claim_deposit`

- requires request status = `Fulfilled`
- validates `owner` and `receiver`
- validates claimant authority
- mints shares to receiver ATA
- decrements `pending_claim_shares`
- closes the request PDA

### Redeem Path

#### `request_redeem`

- transfers shares from user ATA into `share_escrow`
- creates `RedeemRequest`
- does not touch `total_assets`
- does not touch `total_shares`

#### `fulfill_redeem`

- requires request status = `Pending`
- requires request age <= `request_expiry_secs`
- optionally uses oracle pricing
- applies exit fee when module hooks are enabled
- requires `assets_claimable <= vault.total_assets`
- burns escrowed shares
- transfers claimable assets from `asset_vault` into `claimable_tokens`
- creates `ClaimableEscrow`
- moves request to `Fulfilled`
- decrements `total_assets`
- decrements `total_shares`

#### `claim_redeem`

- requires request status = `Fulfilled`
- validates `ClaimableEscrow.amount == RedeemRequest.assets_claimable`
- validates claimant authority
- transfers claimable assets to receiver ATA
- closes `claimable_tokens`, `ClaimableEscrow`, and the request PDA

## Module Integration

SVS-10 preserves the existing `svs-*` module pattern via `remaining_accounts` and per-vault module PDAs.

| Module | Status | Hook Points |
|--------|--------|-------------|
| `svs-fees` | Implemented | `fulfill_deposit`, `fulfill_redeem` |
| `svs-caps` | Implemented | `request_deposit` |
| `svs-access` | Implemented | `request_deposit`, `fulfill_deposit`, `request_redeem`, `fulfill_redeem` |
| `svs-locks` | Implemented | `request_redeem`, `fulfill_redeem` |
| `svs-oracle` | Implemented | optional in `fulfill_deposit`, `fulfill_redeem` |
| `svs-rewards` | Not yet wired in `SVS-10` | future extension |

### Why Fees Apply at Fulfillment

Fees are applied when the settlement amount becomes final, not when the user opens the request.

That is the only defensible place to charge fees in an async product:
- the final settlement amount is known
- operator/oracle context is available
- claims become deterministic afterwards

## System Invariants

These invariants are the core of the implementation and the basis of the fuzz suite.

1. `asset_vault.amount == vault.total_assets + vault.pending_deposit_assets`
2. `vault.total_shares == shares_mint.supply + vault.pending_claim_shares`
3. Pending deposits can never fund redeems because `fulfill_redeem` checks against `vault.total_assets`, not the raw token account balance
4. `share_escrow.amount == sum(pending redeem requests.shares_locked)`
5. At most one active `DepositRequest` per `(vault, owner)`
6. At most one active `RedeemRequest` per `(vault, owner)`
7. `request_*` and `cancel_*` do not change settled economics
8. Only `fulfill_*` changes `vault.total_assets` or `vault.total_shares`
9. `claim_deposit` only converts `pending_claim_shares` into minted supply
10. `claim_redeem` only transfers already-reserved assets and must match `ClaimableEscrow.amount`

## Security Model

### 1. Settlement Authority Is Explicit

Only `vault.operator` can fulfill requests. This isolates the “who decides settlement” trust assumption from the “who can claim” delegation model.

### 2. Claim Delegation Is Narrow

`OperatorApproval` does not grant settlement rights, admin rights, or cancellation rights. It only allows delegated claiming for a specific `(vault, owner, operator)` tuple.

### 3. Request Expiry Prevents Indefinite Settlement Risk

Requests cannot be fulfilled after `vault.request_expiry_secs`. The default configured value is one week.

This prevents a vault operator from settling against stale assumptions long after user intent was expressed.

### 4. Oracle Validation Is Defensive

If an oracle is used:
- both oracle accounts must be supplied together
- the oracle account owner must match the provided program
- stale prices are rejected
- zero prices are rejected
- malformed account data is rejected

### 5. Pending Deposit Isolation Prevents Hidden Insolvency

A common async vault failure mode is using freshly deposited but unissued assets to pay pending redemptions. SVS-10 blocks this by keeping `pending_deposit_assets` separate from `total_assets`.

That means pending deposits are custody, not settled AUM.

### 6. PDA Validation Is Canonical

All request and approval accounts are canonical PDAs with stored bumps. The program does not recalculate or trust caller-supplied addresses without seed validation.

### 7. No Solana-Relevant Reentrancy Assumption Violation

There is no EVM-style callback reentrancy model here. The relevant Solana risk is account substitution and unsafe CPI assumptions, which are addressed by:

- PDA seed constraints
- token account mint/owner checks
- strict signer roles
- explicit oracle ownership validation

## Rounding Policy

SVS-10 keeps the vault-favoring rounding discipline of the base standard:

| Settlement Path | Rounding |
|-----------------|----------|
| Deposit fulfillment (vault-priced) | Floor |
| Redeem fulfillment (vault-priced) | Floor |
| Oracle asset-to-share conversion | Floor-equivalent via integer conversion |
| Oracle share-to-asset conversion | Floor-equivalent via integer conversion |

This ensures the async variant does not accidentally become more permissive than the synchronous base variants.

## SDK and CLI

### TypeScript SDK

The core SDK now includes `AsyncVault`:

```typescript
import { AsyncVault, BN } from "@stbr/solana-vault";

const vault = await AsyncVault.load(program, assetMint, 10);

await vault.requestDeposit(user.publicKey, {
  assets: new BN(1_000_000),
});

await vault.fulfillDeposit(operator.publicKey, {
  owner: user.publicKey,
});

await vault.claimDeposit(user.publicKey);
```

Supported SDK helpers include:

- `requestDeposit`
- `cancelDeposit`
- `fulfillDeposit`
- `claimDeposit`
- `requestRedeem`
- `cancelRedeem`
- `fulfillRedeem`
- `claimRedeem`
- `setOperatorApproval`
- `setVaultOperator`
- `getDepositRequest`
- `getRedeemRequest`
- `getClaimableEscrow`

### CLI

The CLI exposes a dedicated async command group:

```bash
solana-vault config add-vault async-usdc <ADDRESS> --variant svs-10 --asset-mint <MINT>

solana-vault async status async-usdc
solana-vault async request-deposit async-usdc --amount 1000000
solana-vault async fulfill-deposit async-usdc --owner <OWNER>
solana-vault async claim-deposit async-usdc

solana-vault async request-redeem async-usdc --shares 500000000
solana-vault async fulfill-redeem async-usdc --owner <OWNER>
solana-vault async claim-redeem async-usdc
```

The synchronous CLI commands reject `SVS-10` on purpose. That is a safety property, not a limitation.

## Testing and Proof of Implementation

### Program

- Anchor program: `programs/svs-10`
- zero-warning Rust validation with `cargo check`, `cargo clippy -D warnings`, and `cargo test`

### Fuzzing

- Trident target: `trident-tests/fuzz_4/test_fuzz.rs`
- checks escrow conservation, state transitions, stale oracle handling, and pending-deposit isolation

### Bankrun

- test file: `tests/svs-10.bankrun.ts`
- covers initialize, request/fulfill/claim deposit, and request/fulfill/claim redeem
- execution is artifact-gated until `target/idl/svs_10.json` and `target/deploy/svs_10.so` are present

### SDK and CLI

- async SDK tests: `sdk/core/tests/async-vault.test.ts`
- PDA tests extended for async accounts
- CLI tests cover `svs-10` variant handling and `async` subcommands

## Deployment Notes

Configured program ID:

```text
2iu8yL4cuJkG5aYQWpn5Tos5mJfsR1D2JibVWA8E3UiT
```

This is the program ID declared by the `svs-10` program and wired into the SDK/CLI configuration.

## When to Use SVS-10

Use SVS-10 when:
- pricing is determined later than user intent
- operator approval is a real business requirement
- an oracle or off-chain valuation step is part of settlement
- you need explicit pending and claimable states

Do not use SVS-10 when:
- you want synchronous ERC-4626 style UX
- pricing is known immediately at deposit and redeem time
- the added operator trust assumption is unnecessary

In those cases, SVS-1 or SVS-2 is the better design.
