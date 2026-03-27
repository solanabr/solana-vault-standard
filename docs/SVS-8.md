# SVS-8: Multi-Asset Basket Vault

**Status:** Implemented  
**Program ID (Devnet):** `E8bGqwitsaFELBtuhbwAKwVBKjAjGzrfcnBPishvvRsA`  
**Base:** ERC-7575 adapted — Multi-token basket vault

---

## Overview

SVS-8 holds a basket of multiple underlying SPL tokens. A single share mint represents proportional ownership of the entire portfolio. Deposits and redemptions can be made in any of the accepted assets or all at once in proportion.

**Use cases:** index funds, treasury management, diversified yield strategies.

---

## How It Differs from SVS-1

| Aspect | SVS-1 | SVS-8 |
|---|---|---|
| Underlying assets | Single SPL token | Up to 8 SPL tokens |
| Asset vaults | One PDA token account | N PDA token accounts |
| `total_assets` | Single `u64` | Weighted sum across all assets |
| Deposit | Transfer one token | Transfer one or all basket tokens |
| Share price | `total_assets / total_shares` | `weighted_total_value / total_shares` |

---

## State
```rust
#[account]
pub struct MultiAssetVault {
    pub authority: Pubkey,
    pub shares_mint: Pubkey,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub num_assets: u8,       // max 8
    pub base_decimals: u8,    // e.g., 6 for USD
    pub _reserved: [u8; 64],
}
// seeds: ["multi_vault", vault_id.to_le_bytes()]

#[account]
pub struct AssetEntry {
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub oracle: Pubkey,
    pub target_weight_bps: u16,  // 10000 = 100%
    pub asset_decimals: u8,
    pub index: u8,
    pub bump: u8,
}
// seeds: ["asset_entry", vault_pda, asset_mint]
```

---

## Instructions

| # | Instruction | Signer | Description |
|---|---|---|---|
| 1 | `initialize` | Authority | Creates MultiAssetVault PDA and share mint (Token-2022) |
| 2 | `add_asset` | Authority | Adds an AssetEntry to the basket with target weight (bps) |
| 3 | `remove_asset` | Authority | Removes an asset (must have zero balance, re-indexes remaining) |
| 4 | `update_weights` | Authority | Updates target weight for one asset (all weights must sum to 10,000 bps) |
| 5 | `update_oracle` | Authority | Sets or updates OraclePrice PDA for an asset |
| 6 | `deposit_single` | User | Deposits one asset, mints shares priced by full portfolio oracle value |
| 7 | `deposit_proportional` | User | Atomic deposit across ALL basket assets by target weight |
| 8 | `redeem_single` | User | Burns shares, receives proportional amount of one chosen asset |
| 9 | `redeem_proportional` | User | Burns shares, receives proportional amounts from ALL assets |
| 10 | `pause` / `unpause` | Authority | Emergency circuit breaker |
| 11 | `transfer_authority` | Authority | Transfer vault admin (zero-address guarded) |

---

## Pricing Model

Each asset's value is converted to a common base unit using its oracle price:
```
asset_value = balance * price / 10^asset_decimals
total_portfolio_value = sum(asset_value for all assets)
shares = deposit_value * (total_shares + offset) / (total_value + 1)
```

---

## Weight Invariant
```
sum(target_weight_bps for all AssetEntry) <= 10_000  // enforced at add_asset
sum(target_weight_bps for all AssetEntry) == 10_000  // enforced at deposit time
```

`add_asset` allows partial sums (assets added one by one). `deposit_proportional` and `deposit_single` require the full 10,000 bps to be allocated before accepting deposits.

## remaining_accounts Layout

All multi-asset instructions use a structured `remaining_accounts` layout. Module PDAs (FeeConfig, CapConfig, etc.) can be appended after the asset accounts.

### deposit_proportional / redeem_proportional
Quintuplets per asset, followed by optional module PDAs:
```
[AssetEntry PDA, OraclePrice PDA, vault_ata, user_ata, mint]  x  num_assets
[module PDAs...]  // optional, appended after asset accounts
```

### deposit_single / redeem_single
Triplets per OTHER asset (excluding the primary asset in named accounts), followed by optional module PDAs:
```
[AssetEntry PDA, OraclePrice PDA, vault_ata]  x  (num_assets - 1)
[module PDAs...]  // optional, appended after asset accounts
```

All accounts are validated with owner checks before deserialization. vault_ata is validated against `asset_entry.asset_vault`.

---

## Module Compatibility

| Module | Compatible | Notes |
|---|---|---|
| `svs-fees` | ✅ | Fees computed on base-unit deposit/redemption value |
| `svs-caps` | ✅ | Global cap on `total_portfolio_value` |
| `svs-locks` | ✅ | Share-based, works identically |
| `svs-rewards` | ✅ | Rewards distributed per-share |
| `svs-access` | ✅ | Identity-based checks apply normally |
| `svs-oracle` | ✅ | Custom price feeds via module interface |

---

## Limitations

- **Max 8 assets** per basket (compute budget constraint)
- **Oracle dependency** — stale oracle blocks all operations for that asset
- **No atomic rebalancing** — rebalance swaps are separate transactions
- **Single-asset deposit imbalance** — portfolio drifts from target weights on `deposit_single`; authority can rebalance periodically

---

## Devnet Deployment

**Program ID:** `E8bGqwitsaFELBtuhbwAKwVBKjAjGzrfcnBPishvvRsA`  
**Deploy tx:** `36BenKJ91uSPoraJV2YpxWDSxMSqyWj3zhZjryFZmKGJoXS393Pur7fitueVuEebgsBdURqrWjhFAk1DzEw5anfw`  
**Explorer:** https://explorer.solana.com/address/E8bGqwitsaFELBtuhbwAKwVBKjAjGzrfcnBPishvvRsA?cluster=devnet

---

## Usage Example (TypeScript SDK)
```typescript
import { MultiAssetVaultClient } from "@solana-vault-standard/sdk";

const client = new MultiAssetVaultClient(program, provider);

// Initialize vault
await client.initialize(vaultId, "My Basket", "BSKT", "https://...", 6);

// Add asset with 60% weight
await client.addAsset(vaultPda, mintA, oracleA, 6_000);

// Add asset with 40% weight  
await client.addAsset(vaultPda, mintB, oracleB, 4_000);

// Deposit single asset
await client.depositSingle(vaultPda, mintA, 1_000_000, 0);

// Redeem proportional
await client.redeemProportional(vaultPda, shares, 0);
```

---

## Compute Unit Estimates

| Instruction | Approx CU |
|---|---|
| `initialize` | ~25,000 |
| `add_asset` | ~35,000 |
| `deposit_single` | ~50,000 |
| `deposit_proportional` | ~80,000 |
| `redeem_proportional` | ~90,000 |
