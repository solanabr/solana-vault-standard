# SVS-8: Multi-Asset Vault

## Overview

SVS-8 extends the vault standard to hold a basket of up to 8 SPL tokens with oracle-based pricing. A single Token-2022 shares mint represents proportional ownership of the entire portfolio. This enables index funds, treasury management, and diversified yield strategies on Solana.

## Relationship to Other Variants

```
Single-Asset    Multi-Asset
──────────      ──────────
SVS-1 (Live)    SVS-8  ←
SVS-2 (Sync)    —
SVS-5 (Stream)  —
```

SVS-8 uses the SVS-1 live balance model extended to multiple assets. It reuses `svs-math` for safe arithmetic and `svs-oracle` for price feeds. Portfolio value is computed from oracle prices across all assets at deposit time.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Oracle | Mock format `[price_u64, timestamp_i64]` | Pluggable; production replaces with Pyth/Switchboard |
| Rebalance | Generic balance-verification | Any swap program; vault verifies pre/post balances |
| Redeem single | Proportional `shares/supply * balance` | No oracle needed, prevents single-asset drain |
| `total_shares` | Read from `shares_mint.supply` | No stored field (PR #41 pattern) |
| Weight invariant | `sum <= 10000` during setup, `== 10000` for financial ops | Allows incremental asset addition |
| State naming | `MultiAssetVault` | Matches spec-SVS08 |

## Account Structure

### PDAs

| Account | Seeds | Purpose |
|---------|-------|---------|
| **MultiAssetVault** | `["multi_vault", vault_id.to_le_bytes()]` | Vault state (149 bytes) |
| **Shares Mint** | `["shares", vault_pubkey]` | Token-2022 LP mint (9 decimals) |
| **AssetEntry** | `["asset_entry", vault_pubkey, asset_mint]` | Per-asset config (142 bytes) |
| **Asset Vault** | ATA(asset_mint, MultiAssetVault PDA) | Holds assets for each token |

### State: `MultiAssetVault` (149 bytes)

```rust
pub struct MultiAssetVault {
    pub authority: Pubkey,      // 32 — vault admin
    pub shares_mint: Pubkey,    // 32 — Token-2022 LP mint
    pub decimals_offset: u8,    // 1  — 9 - base_decimals (virtual offset)
    pub bump: u8,               // 1  — PDA bump
    pub paused: bool,           // 1  — emergency pause flag
    pub vault_id: u64,          // 8  — unique vault ID
    pub num_assets: u8,         // 1  — current asset count (max 8)
    pub base_decimals: u8,      // 1  — base denomination decimals (e.g. 6 for USD)
    pub _reserved: [u8; 64],    // 64 — future use
}
```

### State: `AssetEntry` (142 bytes)

```rust
pub struct AssetEntry {
    pub vault: Pubkey,          // 32 — parent vault PDA
    pub asset_mint: Pubkey,     // 32 — SPL token mint
    pub asset_vault: Pubkey,    // 32 — ATA holding this asset
    pub oracle: Pubkey,         // 32 — price feed account
    pub oracle_type: u8,        // 1  — 0=Pyth, 1=Switchboard, 2=Custom
    pub target_weight_bps: u16, // 2  — target weight in BPS (10000 = 100%)
    pub asset_decimals: u8,     // 1  — token decimals
    pub index: u8,              // 1  — 0-indexed position
    pub bump: u8,               // 1  — PDA bump
}
```

## Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_ASSETS` | 8 | Maximum tokens in basket |
| `WEIGHT_DENOMINATOR` | 10,000 | 100% in BPS |
| `SHARES_DECIMALS` | 9 | Share token precision |
| `MAX_DECIMALS` | 9 | Maximum supported token decimals |
| `MIN_DEPOSIT_AMOUNT` | 1,000 | Minimum deposit (raw units) |
| `MAX_ORACLE_STALENESS` | 300 | Oracle freshness (5 minutes) |

## Instruction Set

### 1. `initialize(vault_id, base_decimals)`

Creates vault PDA + Token-2022 shares mint via CPI. Sets `decimals_offset = 9 - base_decimals` for inflation protection.

### 2. `add_asset(target_weight_bps, oracle_type)`

Adds an asset to the basket. Creates `AssetEntry` PDA and associated token vault. Validates `current_weight_sum + new_weight <= 10000`. Reads existing weights from remaining_accounts.

### 3. `remove_asset()`

Closes `AssetEntry` account and returns rent. Requires `asset_vault.amount == 0`. Decrements `num_assets`.

### 4. `update_weights(new_weights: Vec<u16>)`

Updates all asset weights atomically via remaining_accounts. Requires `sum == 10000`.

### 5. `deposit_single(amount, min_shares_out)`

Deposits one asset type:
1. Reads all oracle prices via remaining_accounts (3 per asset: entry, vault, oracle)
2. Computes `total_portfolio_value` across all assets
3. Computes `deposit_value = amount * price / 10^decimals`
4. Converts to shares: `deposit_value * (supply + offset) / (total_value + 1)`
5. Validates slippage, transfers asset, mints shares

### 6. `deposit_proportional(base_amount, min_shares_out)`

Deposits all assets in target weight proportion:
- Transfer amount per asset: `base_amount * weight_bps / 10000`
- Remaining accounts: 6 per asset (entry, vault, oracle, mint, user_ata, token_program)

### 7. `redeem_single(shares, min_amount_out)`

Redeems shares for one asset type. **No oracle needed** — uses proportional model:
- `amount_out = shares * asset_vault.amount / total_shares` (floor)

### 8. `redeem_proportional(shares, min_amounts_out)`

Redeems shares for proportional basket of all assets:
- Remaining accounts: 5 per asset (entry, vault, mint, user_ata, token_program)
- Per-asset: `amount_out = shares * balance / total_shares` (floor)

### 9. `rebalance(swap_data, minimum_out)`

Generic balance-verification rebalance:
1. Record `from_vault.amount` before
2. CPI to swap program (from remaining_accounts)
3. Reload balances
4. Verify `received >= minimum_out`

### 10–11. `pause()` / `unpause()` / `transfer_authority(new_authority)`

Standard admin operations. `transfer_authority` guards against `Pubkey::default()`.

### 12–15. View Functions

`preview_deposit`, `total_portfolio_value`, `preview_redeem_single`, `convert_shares_to_value` — return data via `set_return_data`.

## Remaining Accounts Layout

| Instruction | Per-Asset Accounts | Count |
|------------|-------------------|-------|
| `deposit_single` / views | `[entry, vault, oracle]` | N × 3 |
| `deposit_proportional` | `[entry, vault, oracle, mint, user_ata, token_program]` | N × 6 |
| `redeem_proportional` | `[entry, vault, mint, user_ata, token_program]` | N × 5 |
| `update_weights` | `[entry]` | N × 1 |
| `add_asset` | `[existing_entries...]` | (N-1) × 1 |

## Portfolio Math

All math uses `u128` intermediates via `svs-math::mul_div` with configurable rounding.

```
total_portfolio_value = Σ (balance[i] * price[i] / 10^decimals[i])

portfolio_convert_to_shares(deposit_value, supply, total_value, offset):
  virtual_shares = supply + 10^offset
  virtual_value  = total_value + 1
  shares = deposit_value * virtual_shares / virtual_value

asset_value_in_base(balance, price, decimals):
  value = balance * price / 10^decimals
```

Rounding: Floor for deposits and redeems (vault-favoring).

## Weight Invariant

- `add_asset`: `sum(weights) + new_weight <= 10000`
- `update_weights`: `sum(new_weights) == 10000`
- `deposit_*` / `redeem_*` / `rebalance`: `sum(all_weights) == 10000`
- `remove_asset`: Closes entry. Financial ops blocked until `update_weights` restores sum.

## Error Codes

| Error | When |
|-------|------|
| `ZeroAmount` | Deposit/redeem with amount = 0 |
| `DepositTooSmall` | Amount < MIN_DEPOSIT_AMOUNT |
| `SlippageExceeded` | Shares/amount below minimum |
| `VaultPaused` | Operation while paused |
| `MaxAssetsExceeded` | Adding > 8 assets |
| `WeightsNotFullyAllocated` | Financial op when weights != 10000 |
| `OracleStale` | Oracle data older than MAX_ORACLE_STALENESS |
| `OracleInvalid` | Oracle price = 0 or data too short |
| `InsufficientShares` | Redeeming more shares than balance |
| `Unauthorized` | Non-authority calling admin function |

## Testing

- **Anchor test** (`tests/svs-8.ts`): 20 tests covering initialization, asset management, weight updates, admin operations, and input validation
- **Devnet scripts** (`scripts/svs-8/`): Step-by-step scripts for manual testing

Oracle-dependent deposit/redeem integration tests require mock oracle data populated via bankrun or validator fixtures.
