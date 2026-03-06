# SVS-10: Async Vault (ERC-7540)

## Status: Draft
## Authors: Superteam Brasil
## Date: 2026-03-06
## Base: ERC-7540 — Asynchronous ERC-4626 Tokenized Vaults

---

## 1. Overview

SVS-10 is the generic async vault standard for Solana. It replaces atomic deposit/redeem with a request→fulfill→claim lifecycle. An operator (or automated keeper) processes requests asynchronously, allowing the vault to accommodate strategies that cannot settle instantly — illiquid positions, cross-chain bridges, off-chain asset verification, or any workflow requiring human or algorithmic approval.

This is the faithful ERC-7540 port. It does NOT include credit-market-specific features (NAV oracle, KYC attestation, investment windows) — those belong in SVS-11.

---

## 2. How It Differs from SVS-1

| Aspect | SVS-1 (Sync) | SVS-10 (Async) |
|--------|-------------|----------------|
| Deposit flow | Atomic: assets in → shares out (same tx) | request_deposit → fulfill_deposit → claim_deposit |
| Redeem flow | Atomic: shares in → assets out (same tx) | request_redeem → fulfill_redeem → claim_redeem |
| Settlement time | Instant | Operator-dependent (minutes to days) |
| Operator role | None | Processes requests, sets fulfillment price |
| Share price source | Live balance or stored | Set at fulfillment time (via oracle or operator) |

---

## 3. State

```rust
#[account]
pub struct AsyncVault {
    pub authority: Pubkey,
    pub operator: Pubkey,            // can fulfill requests (separate from authority)
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub asset_vault: Pubkey,         // holds deposited assets
    pub total_shares: u64,
    pub total_assets: u64,           // updated at fulfillment
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub max_staleness: i64,          // max oracle age in seconds (for oracle-priced fulfillment)
    pub _reserved: [u8; 64],
}
// seeds: ["async_vault", asset_mint, vault_id.to_le_bytes()]

#[account]
pub struct DepositRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,               // who initiated the request
    pub receiver: Pubkey,            // who receives the shares
    pub assets_locked: u64,          // deposited tokens held in asset_vault
    pub shares_claimable: u64,       // set at fulfillment (0 while pending)
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,           // 0 while pending
    pub bump: u8,
}
// seeds: ["deposit_request", vault_pda, owner_pubkey]

#[account]
pub struct RedeemRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,            // who receives the assets
    pub shares_locked: u64,          // shares held in escrow
    pub assets_claimable: u64,       // set at fulfillment (0 while pending)
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub bump: u8,
}
// seeds: ["redeem_request", vault_pda, owner_pubkey]

#[account]
pub struct ClaimableEscrow {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,                 // assets or shares claimable
    pub bump: u8,
}
// seeds: ["claimable", vault_pda, owner_pubkey]

#[account]
pub struct OperatorApproval {
    pub vault: Pubkey,
    pub owner: Pubkey,               // the account granting approval
    pub operator: Pubkey,            // the approved operator
    pub approved: bool,
    pub bump: u8,
}
// seeds: ["operator_approval", vault_pda, owner_pubkey, operator_pubkey]

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum RequestStatus {
    Pending,
    Fulfilled,
    Claimed,
    Cancelled,
}
```

---

## 4. Token Escrow Accounts

```
deposit flow:
  request  → assets: user wallet → asset_vault (shared pool)
  fulfill  → shares_claimable set on DepositRequest
  claim    → shares: mint to receiver

redeem flow:
  request  → shares: user wallet → share_escrow (PDA-owned)
  fulfill  → assets: asset_vault → claimable_tokens (per-user PDA-owned token account)
           → shares: burned from share_escrow
  claim    → assets: claimable_tokens → receiver wallet
```

| Account | Seeds | Holds | Purpose |
|---------|-------|-------|---------|
| `asset_vault` | `["asset_vault", vault_pda]` | Asset tokens | Shared pool for all deposited assets |
| `share_escrow` | `["share_escrow", vault_pda]` | Share tokens | Shares locked during pending redemptions |
| `claimable_tokens` | `["claimable_tokens", vault_pda, owner]` | Asset tokens | Per-user approved redemption assets |

---

## 5. Instruction Set

| # | Instruction | Signer | Description |
|---|------------|--------|-------------|
| 1 | `initialize` | Authority | Creates AsyncVault, share mint, asset vault, share escrow |
| 2 | `request_deposit` | User | Locks assets, creates DepositRequest PDA |
| 3 | `cancel_deposit` | User | Cancels pending request, returns assets |
| 4 | `fulfill_deposit` | Operator | Sets shares_claimable, marks Fulfilled |
| 5 | `claim_deposit` | User/Receiver | Mints claimable shares to receiver |
| 6 | `request_redeem` | User | Locks shares in escrow, creates RedeemRequest PDA |
| 7 | `cancel_redeem` | User | Cancels pending request, returns shares |
| 8 | `fulfill_redeem` | Operator | Burns shares, moves assets to claimable escrow |
| 9 | `claim_redeem` | User/Receiver | Transfers assets from escrow to receiver |
| 10 | `set_operator` | User | Creates/updates OperatorApproval PDA |
| 11 | `pause` / `unpause` | Authority | Emergency controls |
| 12 | `transfer_authority` | Authority | Transfer admin |
| 13 | `set_vault_operator` | Authority | Change the vault-level operator address |

### 5.1 `request_deposit`

```
request_deposit(assets: u64, receiver: Pubkey):
  ✓ assets > 0, vault not paused
  ✓ No existing DepositRequest for this owner+vault
  → Transfer assets from user to asset_vault
  → Create DepositRequest PDA {
      owner: user,
      receiver: receiver,
      assets_locked: assets,
      shares_claimable: 0,
      status: Pending,
      requested_at: clock.unix_timestamp,
    }
  → emit DepositRequested { vault, owner, receiver, assets }
```

### 5.2 `fulfill_deposit`

The operator decides the share conversion rate. Two modes:

**Mode A: Oracle-priced** — reads from an `svs-oracle::OraclePrice` account:
```
fulfill_deposit(deposit_request_pda: Pubkey):
  ✓ signer == vault.operator
  ✓ deposit_request.status == Pending
  → Read oracle.price_per_share, validate freshness
  → shares = assets_locked * 10^share_decimals / oracle.price_per_share
  → Apply vault-favoring rounding (floor shares)
  → deposit_request.shares_claimable = shares
  → deposit_request.status = Fulfilled
  → deposit_request.fulfilled_at = clock.unix_timestamp
  → vault.total_assets += assets_locked
  → vault.total_shares += shares (pre-account for pending mint)
  → emit DepositFulfilled { vault, owner, assets: assets_locked, shares }
```

**Mode B: Vault-priced** — uses current vault share price:
```
  → shares = convert_to_shares(assets_locked, total_shares, total_assets, offset)
  // Same as SVS-1 math, just deferred to fulfillment time
```

The mode is determined by whether an oracle account is passed as a remaining account.

### 5.3 `claim_deposit`

```
claim_deposit():
  ✓ deposit_request.status == Fulfilled
  ✓ signer == deposit_request.receiver OR signer has OperatorApproval
  → Mint shares to receiver
  → deposit_request.status = Claimed
  → Close DepositRequest PDA (rent to owner)
  → emit DepositClaimed { vault, owner, receiver, shares }
```

### 5.4 `fulfill_redeem`

```
fulfill_redeem(redeem_request_pda: Pubkey):
  ✓ signer == vault.operator
  ✓ redeem_request.status == Pending
  → Compute assets = convert_to_assets(shares_locked, ...) or oracle-priced
  → Apply vault-favoring rounding (floor assets)
  → Burn shares from share_escrow
  → Transfer assets from asset_vault to claimable_tokens account
  → Create ClaimableEscrow PDA { amount: assets }
  → redeem_request.status = Fulfilled
  → vault.total_assets -= assets
  → vault.total_shares -= shares_locked
  → emit RedeemFulfilled { vault, owner, shares: shares_locked, assets }
```

### 5.5 `claim_redeem`

```
claim_redeem():
  ✓ claimable_escrow.amount > 0
  ✓ signer == redeem_request.receiver OR signer has OperatorApproval
  → Transfer assets from claimable_tokens to receiver
  → Close ClaimableEscrow PDA and claimable_tokens account (rent to owner)
  → redeem_request.status = Claimed
  → Close RedeemRequest PDA
  → emit RedeemClaimed { vault, owner, receiver, assets }
```

---

## 6. Operator Model

ERC-7540 defines per-controller operators. On Solana:

- **Vault-level operator:** The `vault.operator` pubkey can fulfill any request. Set by authority.
- **Per-user operators:** Users create `OperatorApproval` PDAs to allow third parties to claim on their behalf. This enables composability — a protocol can deposit on behalf of users and claim their shares.

```
set_operator(operator: Pubkey, approved: bool):
  ✓ signer == owner
  → Create or update OperatorApproval PDA
  → emit OperatorSet { vault, owner, operator, approved }
```

---

## 7. View Functions

```
pending_deposit_request(owner: Pubkey) → u64
  → Returns deposit_request.assets_locked if status == Pending, else 0

claimable_deposit_request(owner: Pubkey) → u64
  → Returns deposit_request.shares_claimable if status == Fulfilled, else 0

pending_redeem_request(owner: Pubkey) → u64
  → Returns redeem_request.shares_locked if status == Pending, else 0

claimable_redeem_request(owner: Pubkey) → u64
  → Returns claimable_escrow.amount if exists, else 0
```

These map 1:1 to the ERC-7540 view functions.

---

## 8. Single Request Per User

Each user can have at most one DepositRequest and one RedeemRequest per vault at a time. The PDA seed `[vault, owner]` enforces this — attempting to create a second request fails because the PDA already exists.

To submit a new request, the user must first cancel or claim the existing one. This simplifies state management and matches ERC-7540's per-controller tracking.

---

## 9. Module Compatibility

- **svs-fees:** Entry fee applied at fulfillment (not request). Exit fee applied at fulfillment. Management fee accrued on `total_assets`.
- **svs-caps:** Checked at `request_deposit` time. The cap check uses `total_assets + assets_being_requested` to include pending deposits.
- **svs-locks:** ShareLock set when `claim_deposit` mints shares. Checked on `request_redeem`.
- **svs-access:** Checked at `request_deposit` and `request_redeem`. Re-checked at fulfillment (access could be revoked between request and fulfillment).
- **svs-oracle:** Used by operator for oracle-priced fulfillment.

---

## 10. ERC-7540 Compliance Mapping

| ERC-7540 Function | SVS-10 Instruction | Notes |
|---|---|---|
| `requestDeposit(assets, controller, owner)` | `request_deposit(assets, receiver)` | `controller` = owner on Solana (signer) |
| `pendingDepositRequest(controller)` | `pending_deposit_request(owner)` | View function |
| `claimableDepositRequest(controller)` | `claimable_deposit_request(owner)` | View function |
| `deposit(assets, receiver, controller)` | `claim_deposit()` | Claims fulfilled deposit |
| `requestRedeem(shares, controller, owner)` | `request_redeem(shares, receiver)` | |
| `pendingRedeemRequest(controller)` | `pending_redeem_request(owner)` | View function |
| `claimableRedeemRequest(controller)` | `claimable_redeem_request(owner)` | View function |
| `redeem(shares, receiver, controller)` | `claim_redeem()` | Claims fulfilled redeem |
| `setOperator(operator, approved)` | `set_operator(operator, approved)` | Per-user operator approval |

---

## 11. Security Considerations

- **Request front-running:** An operator could see a pending request and manipulate the vault's share price before fulfilling. Mitigation: oracle-priced fulfillment with freshness checks, or time-weighted average pricing.
- **Operator liveness:** If the operator goes offline, requests are stuck. Mitigation: add a `cancel_after` timestamp to requests, allowing users to cancel and reclaim assets after a timeout.
- **Escrow isolation:** Assets in `claimable_tokens` are per-user PDA-owned accounts. One user's claimable assets cannot be accessed by another user or the operator.
- **CPI validation:** Ensure `vault.operator` is checked on every fulfill instruction. The operator address change (`set_vault_operator`) should emit an event for off-chain monitoring.
