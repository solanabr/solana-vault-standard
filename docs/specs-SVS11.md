# SVS-11: Credit Markets Vault

## Status: Draft
## Authors: Superteam Brasil
## Date: 2026-03-06
## Base: SVS-10 (Async) + External NAV Oracle + KYC Attestation + Credit Operations

---

## 1. Overview

SVS-11 is the credit-market-optimized async vault. It extends SVS-10's request→fulfill→claim lifecycle with features specific to regulated credit products: an external NAV oracle for pricing, on-chain KYC attestation enforcement, investment window controls, originator repayment ingestion, and compliance freeze capabilities.

This vault is designed for tokenized credit funds (FIDCs, CLOs, private credit) where every financial action requires manager authorization and regulatory compliance checks.

**Core invariant:** Every financial action is a two-step manager-gated async flow. The system never auto-approves, auto-refunds, auto-closes, or auto-fails anything. The manager is always the human in the loop.

---

## 2. Two-Program Architecture

```
┌─────────────────────────────────────────────────────┐
│  External: credit_markets_nav_oracle                │
│  (separate repo, separate deployment)               │
│  Implements svs-oracle::OraclePrice interface        │
│  Posted by: Credit Markets operator keypair          │
│  Source: Risk Index pipeline (off-chain)             │
│  Contains: nav_per_share (includes hedge P&L, fees)  │
└────────────────────┬────────────────────────────────┘
                     │ Account read (not CPI)
┌────────────────────▼────────────────────────────────┐
│  SVS-11: credit_markets_vault                        │
│  (this repo)                                         │
│  Reads OraclePrice at approval time                  │
│  Enforces KYC attestation on every financial ix      │
│  Manager-gated individual request processing         │
└─────────────────────────────────────────────────────┘
```

The vault reads the oracle account by deserializing it as `svs-oracle::OraclePrice`. The oracle program is NOT part of this repo — it lives in the credit-markets infrastructure repo and conforms to the shared interface from `modules/svs-oracle/`.

---

## 3. State

```rust
#[account]
pub struct CreditVault {
    // ── Core fields ──
    pub authority: Pubkey,           // platform admin
    pub manager: Pubkey,             // fund manager (approves/rejects requests)
    pub asset_mint: Pubkey,          // deposit token (USDC, USDT, BRLA, etc.)
    pub shares_mint: Pubkey,         // Senior Share token
    pub deposit_vault: Pubkey,       // PDA-owned token account for investor capital + repayments
    pub redemption_escrow: Pubkey,   // PDA-owned token account for locked shares

    // ── Oracle ──
    pub nav_oracle: Pubkey,          // OraclePrice PDA from oracle program
    pub oracle_program: Pubkey,      // program ID of oracle (validated on read)

    // ── KYC ──
    pub attester: Pubkey,            // trusted KYC attester address
    pub attestation_program: Pubkey, // program ID of attestation protocol

    // ── Vault state ──
    pub total_assets: u64,
    pub total_shares: u64,
    pub minimum_investment: u64,
    pub investment_window_open: bool,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,

    pub _reserved: [u8; 64],
}
// seeds: ["credit_vault", asset_mint, vault_id.to_le_bytes()]

#[account]
pub struct InvestmentRequest {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub amount_locked: u64,
    pub shares_to_receive: u64,      // 0 while pending, set at approval
    pub status: RequestStatus,
    pub requested_at: i64,
    pub bump: u8,
}
// seeds: ["investment_request", vault_pda, investor_pubkey]

#[account]
pub struct RedemptionRequest {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub shares_locked: u64,
    pub amount_claimable: u64,       // 0 while pending, set at approval
    pub status: RedemptionStatus,
    pub requested_at: i64,
    pub bump: u8,
}
// seeds: ["redemption_request", vault_pda, investor_pubkey]

#[account]
pub struct ClaimableEscrow {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub amount_claimable: u64,
    pub bump: u8,
}
// seeds: ["claimable", vault_pda, investor_pubkey]

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum RequestStatus { Pending, Approved, Rejected }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum RedemptionStatus { Pending, Approved }
```

---

## 4. Token Escrow Accounts

| Account | Seeds | Holds | Purpose |
|---------|-------|-------|---------|
| `deposit_vault` | `["deposit_vault", vault_pda]` | Deposit token | Investor capital + repayments |
| `redemption_escrow` | `["redemption_escrow", vault_pda]` | Share tokens | Shares locked during pending redemptions |
| `claimable_tokens` | `["claimable_tokens", vault_pda, investor]` | Deposit token | Approved redemption awaiting investor claim |

---

## 5. Instruction Set

| # | Instruction | Signer | Description |
|---|------------|--------|-------------|
| 1 | `initialize_pool` | Authority | Creates CreditVault PDA, share mint, deposit vault, redemption escrow |
| 2 | `open_investment_window` | Manager | Sets `investment_window_open = true` |
| 3 | `close_investment_window` | Manager | Sets `investment_window_open = false` |
| 4 | `request_deposit` | Investor | Locks deposit tokens, creates InvestmentRequest PDA |
| 5 | `approve_deposit` | Manager | Reads oracle NAV, mints shares to investor |
| 6 | `reject_deposit` | Manager | Closes InvestmentRequest, returns deposit tokens |
| 7 | `cancel_deposit` | Investor | Cancels while Pending, returns deposit tokens |
| 8 | `request_redeem` | Investor | Transfers shares to escrow, creates RedemptionRequest PDA |
| 9 | `approve_redeem` | Manager | Reads oracle NAV, burns shares, moves tokens to ClaimableEscrow |
| 10 | `cancel_redeem` | Investor | Cancels while Pending, returns shares from escrow |
| 11 | `claim_redemption` | Investor | Transfers claimable tokens to investor wallet |
| 12 | `repay` | Manager | Deposits repayment tokens into deposit_vault |
| 13 | `update_attester` | Authority | Updates trusted attester address on vault |
| 14 | `freeze_account` | Manager | Creates FrozenAccount PDA for an investor |
| 15 | `unfreeze_account` | Manager | Closes FrozenAccount PDA |
| 16 | `pause` / `unpause` | Authority | Emergency controls |
| 17 | `transfer_authority` | Authority | Transfer admin |
| 18 | `set_manager` | Authority | Change manager address |

---

## 6. Permission Checks

```
request_deposit:
  ✓ vault.investment_window_open == true
  ✓ amount >= vault.minimum_investment
  ✓ Attestation PDA exists for investor
  ✓ attestation.attester == vault.attester
  ✓ attestation.valid_until > clock.unix_timestamp
  ✓ FrozenAccount PDA does NOT exist for this investor+vault
  ✓ No existing InvestmentRequest PDA for this investor+vault

approve_deposit:
  ✓ signer == vault.manager
  ✓ investment_request.status == Pending
  ✓ Attestation re-validated (may have expired since request)
  ✓ FrozenAccount PDA does NOT exist
  ✓ NavOracle PDA exists and nav_per_share > 0
  ✓ Oracle freshness: posted_at > clock.unix_timestamp - max_staleness

reject_deposit:
  ✓ signer == vault.manager
  ✓ investment_request.status == Pending

cancel_deposit:
  ✓ signer == investor
  ✓ investment_request.status == Pending

request_redeem:
  ✓ investor share balance >= shares_to_lock
  ✓ Attestation valid and not expired
  ✓ FrozenAccount PDA does NOT exist
  ✓ No existing RedemptionRequest for this investor+vault

approve_redeem:
  ✓ signer == vault.manager
  ✓ redemption_request.status == Pending
  ✓ deposit_vault.amount >= amount_claimable
  ✓ NavOracle PDA exists and nav_per_share > 0

claim_redemption:
  ✓ signer == investor
  ✓ ClaimableEscrow PDA exists and amount_claimable > 0

repay:
  ✓ signer == vault.manager
  ✓ amount > 0
```

---

## 7. NAV Pricing

Shares are priced at **approval time**, not request time:

```
approve_deposit:
  shares_to_receive = amount_locked * 10^share_decimals / nav_oracle.nav_per_share
  // Floor rounding — investor gets fewer shares (vault-favoring)

approve_redeem:
  amount_claimable = shares_locked * nav_oracle.nav_per_share / 10^share_decimals
  // Floor rounding — investor gets fewer assets (vault-favoring)
```

The investor transacts at the NAV current when the manager processes — not when they submitted. This prevents NAV timing games and matches how regulated fund subscriptions work operationally.

---

## 8. KYC Attestation

The vault reads an external attestation PDA at request and approval time:

```rust
/// External attestation account (owned by attestation program)
pub struct Attestation {
    pub subject: Pubkey,         // the investor wallet
    pub attester: Pubkey,        // who issued this (must match vault.attester)
    pub valid_until: i64,        // expiry timestamp
    // schema fields TBD for future phases
}
```

The vault does NOT know how KYC was conducted. It only verifies that a valid attestation exists from the trusted attester and hasn't expired. The attestation protocol (Solana Attestation Service, Civic Pass, or custom) is pluggable — the vault reads any account that matches this layout.

Re-validation at approval time is critical: KYC could expire between request and manager processing.

---

## 9. Compliance Freeze

The `svs-access` module's `FrozenAccount` pattern is built into SVS-11:

```
freeze_account(investor: Pubkey):
  ✓ signer == vault.manager
  → Creates FrozenAccount PDA { investor, vault, frozen_by: manager, frozen_at: now }
  → Blocks: request_deposit, approve_deposit, request_redeem for this investor
  → Does NOT block: claim_redemption (already approved assets must remain claimable)

unfreeze_account(investor: Pubkey):
  ✓ signer == vault.manager
  → Closes FrozenAccount PDA
```

---

## 10. Repayment Flow

```
repay(amount: u64):
  ✓ signer == vault.manager
  → Transfer deposit tokens from originator/source to deposit_vault
  → vault.total_assets += amount
  → emit Repayment { vault, amount, new_total_assets }

  NOTE: NAV per share is NOT updated here. The Risk Index pipeline
  recalculates NAV monthly and posts to the oracle separately.
  Repayment increases vault liquidity for redemption approvals.
```

---

## 11. Investment Window

```
open_investment_window:
  ✓ signer == vault.manager
  → vault.investment_window_open = true

close_investment_window:
  ✓ signer == vault.manager
  → vault.investment_window_open = false
  → Does NOT affect pending InvestmentRequest PDAs
```

Window state only gates new `request_deposit` calls. Existing pending requests continue through their lifecycle regardless of window state.

---

## 12. Differences from SVS-10

| Aspect | SVS-10 (Generic Async) | SVS-11 (Credit Markets) |
|--------|----------------------|------------------------|
| Pricing | Vault-priced or oracle-priced (either) | Oracle-only (external NAV required) |
| Access control | Optional (via svs-access module) | Built-in (attestation + freeze) |
| Operator model | Generic operator role | Manager role with fund-admin semantics |
| Investment gating | None | Investment window (manager-controlled) |
| Repayment | Not applicable | `repay` instruction for originator inflows |
| Cancel redeem | Yes | Yes |
| KYC re-check | Not applicable | Re-validated at approval time |

SVS-11 uses SVS-10's core async flow but replaces the generic operator with a regulated fund manager, adds compliance layers, and introduces credit-specific operations.

---

## 13. Module Compatibility

- **svs-fees:** Management fee on total_assets. Performance fee on NAV appreciation above high-water mark. Entry/exit fees at approval time.
- **svs-caps:** Global cap on total_assets (fund size limit). Per-user cap for concentration limits.
- **svs-locks:** Share lockup after approval (e.g., 90-day lock-in period for credit fund investors).
- **svs-rewards:** Not typical for credit products but compatible if needed.
- **svs-access:** Partially redundant — SVS-11 has built-in attestation + freeze. Merkle whitelist from svs-access could layer on top for additional access tiers.
- **svs-oracle:** Required. Oracle interface is the bridge to the external NAV oracle program.

---

## 14. Events

```rust
#[event]
pub struct InvestmentRequested { pub vault: Pubkey, pub investor: Pubkey, pub amount: u64 }
#[event]
pub struct InvestmentApproved { pub vault: Pubkey, pub investor: Pubkey, pub amount: u64, pub shares: u64, pub nav: u64 }
#[event]
pub struct InvestmentRejected { pub vault: Pubkey, pub investor: Pubkey, pub amount: u64, pub reason_code: u8 }
#[event]
pub struct InvestmentCancelled { pub vault: Pubkey, pub investor: Pubkey, pub amount: u64 }
#[event]
pub struct RedemptionRequested { pub vault: Pubkey, pub investor: Pubkey, pub shares: u64 }
#[event]
pub struct RedemptionApproved { pub vault: Pubkey, pub investor: Pubkey, pub shares: u64, pub assets: u64, pub nav: u64 }
#[event]
pub struct RedemptionClaimed { pub vault: Pubkey, pub investor: Pubkey, pub assets: u64 }
#[event]
pub struct Repayment { pub vault: Pubkey, pub amount: u64, pub new_total_assets: u64 }
#[event]
pub struct WindowOpened { pub vault: Pubkey }
#[event]
pub struct WindowClosed { pub vault: Pubkey }
#[event]
pub struct AccountFrozen { pub vault: Pubkey, pub investor: Pubkey, pub frozen_by: Pubkey }
#[event]
pub struct AccountUnfrozen { pub vault: Pubkey, pub investor: Pubkey }
```

---

## 15. Build Order

```
Group 0 — Oracle interface (svs-oracle module):
  Shared OraclePrice struct. No deployment — just a crate.

Group 1 — Pool initialization + attestation:
  initialize_pool + attestation check plumbing
  Test: pool exists, attestation check passes/fails correctly

Group 2 — Full investment flow:
  open_window → request_deposit → approve_deposit
  Also: reject_deposit, cancel_deposit
  Test: tokens move, shares minted at oracle NAV, attestation + freeze enforced

Group 3 — Full redemption flow:
  request_redeem → approve_redeem → claim_redemption
  Also: cancel_redeem
  Test: shares locked, burned at oracle NAV, tokens arrive in investor wallet

Group 4 — Repayment:
  repay
  Test: vault balance increases, total_assets updated

Group 5 — Compliance:
  freeze_account, unfreeze_account
  Test: frozen investor blocked from requests, existing claims unaffected
```
