# SVS-8: Multi-Asset Vault

## Status: Draft
## Authors: Superteam Brasil
## Date: 2026-03-06
## Base: ERC-7575 adapted — Multi-token basket vault

---

## 1. Overview

SVS-8 holds a basket of multiple underlying SPL tokens. A single share mint represents proportional ownership of the entire portfolio. Deposits and redemptions can be made in any of the accepted assets (or all at once in proportion).

This vault type targets index funds, treasury management, diversified yield strategies, and any product where a single tokenized position represents exposure to multiple assets.

---

## 2. How It Differs from SVS-1

| Aspect | SVS-1 | SVS-8 |
|--------|-------|-------|
| Underlying assets | Single SPL token | N SPL tokens (configurable basket) |
| Asset vaults | One PDA-owned token account | N PDA-owned token accounts |
| `total_assets` | Single u64 | Weighted sum across all assets (denominated in base unit) |
| Deposit | Transfer one token | Transfer one or more basket tokens |
| Redeem | Receive one token | Receive proportional basket or single token |
| Share price | `total_assets / total_shares` | `weighted_total_value / total_shares` |

---

## 3. State

```rust
#[account]
pub struct MultiAssetVault {
    pub authority: Pubkey,
    pub shares_mint: Pubkey,
    pub total_shares: u64,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub num_assets: u8,              // number of assets in basket (max 8)
    pub base_decimals: u8,           // decimal precision for weighted value (e.g., 6 for USD)
    pub _reserved: [u8; 64],
}
// seeds: ["multi_vault", vault_id.to_le_bytes()]

#[account]
pub struct AssetEntry {
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub asset_vault: Pubkey,         // PDA-owned token account
    pub oracle: Pubkey,              // price oracle for this asset (Pyth, Switchboard, or svs-oracle)
    pub target_weight_bps: u16,      // target allocation (10000 = 100%)
    pub asset_decimals: u8,
    pub index: u8,                   // position in basket (0-indexed)
    pub bump: u8,
}
// seeds: ["asset_entry", vault_pda, asset_mint]
```

---

## 4. Pricing Model

Each asset's value is converted to a common base unit (e.g., USD with 6 decimals) using its oracle price:

```rust
/// Total portfolio value in base units
pub fn total_portfolio_value(
    assets: &[AssetEntry],
    balances: &[u64],
    prices: &[u64],         // price per token in base units (e.g., USDC price = 1_000_000)
) -> Result<u64> {
    let mut total: u128 = 0;
    for i in 0..assets.len() {
        // value = balance * price / 10^asset_decimals
        let value = (balances[i] as u128)
            .checked_mul(prices[i] as u128)?
            .checked_div(10u128.pow(assets[i].asset_decimals as u32))?;
        total = total.checked_add(value)?;
    }
    u64::try_from(total).map_err(|_| error!(VaultError::MathOverflow))
}

/// Share conversion uses total_portfolio_value as the denominator
pub fn convert_to_shares(
    deposit_value: u64,      // value of deposited assets in base units
    total_shares: u64,
    total_value: u64,        // total_portfolio_value
    offset: u64,
) -> Result<u64> {
    mul_div(deposit_value, total_shares + offset, total_value + 1, Rounding::Floor)
}
```

---

## 5. Instruction Set

| # | Instruction | Signer | Description |
|---|------------|--------|-------------|
| 1 | `initialize` | Authority | Creates MultiAssetVault PDA and share mint |
| 2 | `add_asset` | Authority | Adds an AssetEntry to the basket |
| 3 | `remove_asset` | Authority | Removes an asset (must have zero balance) |
| 4 | `update_weights` | Authority | Rebalances target weights (must sum to 10000) |
| 5 | `deposit_single` | User | Deposits one asset, mints shares based on its value |
| 6 | `deposit_proportional` | User | Deposits all assets in target weight proportions |
| 7 | `redeem_single` | User | Redeems shares for one asset |
| 8 | `redeem_proportional` | User | Redeems shares for proportional basket |
| 9 | `rebalance` | Authority | Swaps between asset vaults to match target weights |
| 10 | `pause` / `unpause` | Authority | Emergency controls |
| 11 | `transfer_authority` | Authority | Transfer admin |

### 5.1 `deposit_single`

```
deposit_single(asset_mint: Pubkey, amount: u64, min_shares_out: u64):
  ✓ asset_mint is in the basket (AssetEntry exists)
  ✓ amount > 0, vault not paused
  → Read oracle price for deposited asset
  → deposit_value = amount * price / 10^asset_decimals
  → Read all oracle prices, compute total_portfolio_value
  → shares = convert_to_shares(deposit_value, total_shares, total_value, offset)
  → require!(shares >= min_shares_out)
  → Transfer asset from user to asset_vault
  → Mint shares
  → emit Deposit { vault, asset_mint, amount, shares, value: deposit_value }
```

### 5.2 `deposit_proportional`

```
deposit_proportional(base_amount: u64, min_shares_out: u64):
  ✓ vault not paused
  → For each asset in basket:
      asset_amount = base_amount * asset.target_weight_bps / 10000
      Transfer asset_amount from user to asset_vault
  → total_deposit_value = sum of all asset values
  → shares = convert_to_shares(total_deposit_value, ...)
  → require!(shares >= min_shares_out)
  → Mint shares
  → emit ProportionalDeposit { vault, amounts: [...], shares }
```

### 5.3 `redeem_proportional`

```
redeem_proportional(shares: u64, min_values_out: [u64; N]):
  ✓ vault not paused, user has enough shares
  → total_value = total_portfolio_value()
  → redeem_value = convert_to_assets(shares, total_shares, total_value, offset)
  → For each asset:
      asset_share = asset_vault.amount * shares / total_shares
      require!(asset_share >= min_values_out[i])
      Transfer asset_share from asset_vault to user
  → Burn shares
  → emit ProportionalRedeem { vault, shares, amounts: [...] }
```

### 5.4 `rebalance`

Authority-initiated rebalancing to match target weights. Uses remaining accounts pattern to pass swap program (Jupiter) and route accounts.

```
rebalance(from_asset: Pubkey, to_asset: Pubkey, amount: u64, min_out: u64):
  ✓ signer == vault.authority
  → CPI to swap program (Jupiter aggregator)
  → Transfer `amount` of from_asset, receive >= min_out of to_asset
  → emit Rebalance { from_asset, to_asset, amount_in, amount_out }
```

---

## 6. Oracle Requirements

Each `AssetEntry` references a price oracle. The vault reads prices at deposit/redeem time. Supported oracle types:

- **Pyth:** Read `PriceUpdateV2` account, extract `price` and `expo`, check `publish_time` freshness.
- **Switchboard:** Read `AggregatorAccountData`, extract `latest_confirmed_round.result`.
- **svs-oracle:** Read `OraclePrice` account from the module interface (for custom/internal prices).

The vault validates freshness: `require!(oracle.updated_at > clock.unix_timestamp - MAX_STALENESS)`. Stale prices block all financial operations for that asset.

---

## 7. Remaining Accounts Pattern

With up to 8 assets, each having an asset_vault, AssetEntry PDA, and oracle account, a single instruction can require 24+ accounts. Solana's transaction account limit is 64, which is sufficient, but the instruction definition should use remaining accounts for the per-asset data:

```rust
#[derive(Accounts)]
pub struct DepositSingle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, MultiAssetVault>,
    pub shares_mint: Account<'info, Mint>,
    // ... standard accounts ...

    // Per-asset data passed as remaining_accounts:
    // [AssetEntry, asset_vault, oracle] × num_assets
}
```

---

## 8. Weight Invariant

`sum(target_weight_bps for all AssetEntry) == 10_000`

This invariant is checked on `add_asset`, `remove_asset`, and `update_weights`. The vault cannot enter a state where weights don't sum to 100%.

---

## 9. Single-Asset Deposit Imbalance

When a user deposits a single asset into a multi-asset vault, the portfolio drifts from target weights. This is acceptable — the authority can `rebalance` periodically. The vault does NOT auto-rebalance on deposit (that would require CPI to a swap program on every deposit, adding cost and complexity).

For vaults that want to enforce balanced deposits, `deposit_proportional` is the only enabled deposit method. The authority can disable `deposit_single` by setting a flag on the vault (future enhancement, not MVP).

---

## 10. Module Compatibility

- **svs-fees:** Fees computed on the base-unit value of the deposit/redemption.
- **svs-caps:** Global cap on total_portfolio_value. Per-user cap on cumulative deposited value.
- **svs-locks:** Works identically (share-based).
- **svs-rewards:** Compatible. Rewards distributed per-share regardless of underlying basket composition.
- **svs-access:** Compatible. Identity-based checks.

---

## 11. Limitations

- **Max 8 assets per basket.** Practical limit from account size and compute budget. Can be increased if Solana raises compute limits.
- **Oracle dependency.** Every financial operation requires fresh prices for ALL basket assets. A single stale oracle blocks the entire vault.
- **No atomic rebalancing.** Rebalance swaps are separate transactions. MEV is possible between legs of a multi-step rebalance. Mitigation: use Jupiter's route API for optimal execution in a single tx.
- **Share price tracking.** Divergence between actual portfolio weights and target weights means share price reflects actual holdings, not target allocation.
