# SVS-11: Credit Markets Vault

## Overview

SVS-11 implements a manager-gated credit vault for RWA (Real World Asset) lending and credit markets on Solana. It extends SVS-10's async request→approve→claim lifecycle with credit-market features: manager-gated approvals, external NAV oracle-only pricing, KYC attestation enforcement, investment windows, repayment, and compliance freezes.

**Core invariant**: Every financial action is manager-gated. No auto-approvals, auto-refunds, or auto-fails.

**Program ID**: `SVS8w4PozVex3B2RWbPJDjvacZaWZm4xaCwbtZb1dqA`

## Key Differences from SVS-10

| Aspect | SVS-10 | SVS-11 |
|--------|--------|--------|
| Pricing | Oracle OR vault-priced | **Oracle-ONLY** (mandatory) |
| Fulfillment | `fulfill_deposit` → `claim_deposit` (2-step) | `approve_deposit` mints shares directly (1-step) |
| Access control | Optional (svs-access module) | **Built-in** attestation + freeze |
| Operator | Generic operator + OperatorApproval | **Manager** role (fund-admin) |
| Investment gating | None | **Investment window** (boolean) |
| Repayment | N/A | **`repay` instruction** |
| Cancel delay | Configurable | **None** (instant cancel while Pending) |
| Reject | N/A | **`reject_deposit`** (manager returns tokens) |

## Account Structure

### PDA Derivation

| Account | Seeds | Authority |
|---------|-------|-----------|
| **CreditVault** | `["credit_vault", asset_mint, vault_id.to_le_bytes()]` | User-specified on init |
| **Shares Mint** | `["shares", vault_pubkey]` | Vault PDA |
| **Deposit Vault** | `["deposit_vault", vault_pubkey]` | Vault PDA |
| **Redemption Escrow** | `["redemption_escrow", vault_pubkey]` | Vault PDA |
| **InvestmentRequest** | `["investment_request", vault, investor]` | — |
| **RedemptionRequest** | `["redemption_request", vault, investor]` | — |
| **ClaimableEscrow** | `["claimable", vault, investor]` | — |
| **ClaimableTokens** | `["claimable_tokens", vault, investor]` | Vault PDA |
| **FrozenAccount** | `["frozen_account", vault, investor]` | — |

### CreditVault State

```rust
pub struct CreditVault {
    pub authority: Pubkey,           // 32
    pub manager: Pubkey,             // 32
    pub asset_mint: Pubkey,          // 32
    pub shares_mint: Pubkey,         // 32
    pub deposit_vault: Pubkey,       // 32
    pub redemption_escrow: Pubkey,   // 32
    pub nav_oracle: Pubkey,          // 32
    pub oracle_program: Pubkey,      // 32
    pub attester: Pubkey,            // 32
    pub attestation_program: Pubkey, // 32
    pub total_assets: u64,           // 8
    pub total_shares: u64,           // 8
    pub minimum_investment: u64,     // 8
    pub investment_window_open: bool,// 1
    pub decimals_offset: u8,         // 1
    pub bump: u8,                    // 1
    pub paused: bool,                // 1
    pub vault_id: u64,               // 8
    pub max_staleness: i64,          // 8
    pub _reserved: [u8; 64],        // 64
}
```

## Instruction Reference

### Initialize
- `initialize_pool(vault_id, minimum_investment, max_staleness)` — Authority creates vault, shares mint, deposit vault, redemption escrow

### Investment Window
- `open_investment_window` — Manager opens deposit window
- `close_investment_window` — Manager closes deposit window

### Deposit Flow
- `request_deposit(amount)` — Investor deposits assets (requires attestation, window open, not frozen)
- `approve_deposit` — Manager approves, mints shares directly (requires oracle, re-validates attestation)
- `reject_deposit(reason_code)` — Manager returns locked assets
- `cancel_deposit` — Investor cancels (instant, no delay)

### Redemption Flow
- `request_redeem(shares)` — Investor locks shares in escrow (requires attestation, not frozen)
- `approve_redeem` — Manager approves, burns shares, creates claimable tokens (requires oracle)
- `cancel_redeem` — Investor cancels, shares returned
- `claim_redemption` — Investor claims assets (no attestation/freeze check — spec requirement)

### Repayment
- `repay(amount)` — Manager repays assets to deposit vault, increases total_assets

### Compliance
- `freeze_account` — Manager creates FrozenAccount PDA, blocking deposits/redeems
- `unfreeze_account` — Manager closes FrozenAccount PDA

### Admin
- `pause` / `unpause` — Authority toggles vault
- `transfer_authority(new_authority)` — Authority transfers control
- `set_manager(new_manager)` — Authority assigns new manager
- `update_attester(new_attester)` — Authority changes KYC attester

## Security Model

| Risk | Mitigation |
|------|-----------|
| NAV oracle manipulation | `max_staleness` enforcement, external oracle program validation |
| Attestation spoofing | Validate `account.owner == vault.attestation_program` before deserialization |
| Freeze-after-approve | `claim_redemption` skips freeze + attestation checks (spec-required) |
| Pre-funded PDA griefing | Allocate+assign pattern for claimable_tokens |
| Token-2022 transfer fees | Delta-based accounting (before/after balance checks) |
| Double-count prevention | total_shares/total_assets updated at approve (not claim) |

## Module Compatibility

SVS-11 supports the same module system as SVS-10 when built with `--features modules`:
- **svs-fees**: Entry/exit fees on approve_deposit/approve_redeem
- **svs-caps**: Global and per-user deposit caps
- **svs-locks**: Time-locked shares
- **svs-access**: Whitelist/blacklist with merkle proofs

## SDK Usage

```typescript
import { CreditVault } from "@stbr/solana-vault";

// Load existing vault
const vault = await CreditVault.load(program, assetMint, 1);

// Investor: request deposit
await vault.requestDeposit(investor, new BN(1_000_000), attestationPda);

// Manager: approve deposit (mints shares directly)
await vault.approveDeposit(manager, investor.publicKey, oracleAccount, attestationPda);

// Manager: repay assets
await vault.repay(manager, new BN(500_000));

// Manager: freeze/unfreeze
await vault.freezeAccount(manager, investor.publicKey);
await vault.unfreezeAccount(manager, investor.publicKey);

// View
const isFrozen = await vault.isFrozen(investor.publicKey);
const request = await vault.getInvestmentRequest(investor.publicKey);
```

## CLI Usage

```bash
# Show vault state
solana-vault credit show <vault>

# Investor operations
solana-vault credit request-deposit <vault> -a 1000000 --attestation <PDA>
solana-vault credit cancel-deposit <vault>
solana-vault credit request-redeem <vault> -s 1000000 --attestation <PDA>
solana-vault credit cancel-redeem <vault>
solana-vault credit claim <vault>

# Manager operations
solana-vault credit approve-deposit <vault> --investor <PK> --oracle <PDA> --attestation <PDA>
solana-vault credit reject-deposit <vault> --investor <PK> --reason 1
solana-vault credit approve-redeem <vault> --investor <PK> --oracle <PDA>
solana-vault credit repay <vault> -a 500000
solana-vault credit window open <vault>
solana-vault credit window close <vault>
solana-vault credit freeze <vault> --investor <PK>
solana-vault credit unfreeze <vault> --investor <PK>

# Admin
solana-vault credit admin pause <vault>
solana-vault credit admin unpause <vault>
solana-vault credit admin transfer-authority <vault> --new-authority <PK>
solana-vault credit admin set-manager <vault> --new-manager <PK>
solana-vault credit admin update-attester <vault> --new-attester <PK>
```
