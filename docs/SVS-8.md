# SVS-8: Multi-Asset Basket Vault

> **Status:** Implementation complete
> **Program ID:** `SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j` (devnet)

## Overview

SVS-8 implements a **multi-asset basket vault**: a single share token representing proportional ownership of up to 8 underlying SPL tokens. It is the Solana-native analog of ERC-7575 and an extension of the core SVS vault architecture.

**Use cases:** index funds, treasury management, diversified yield strategies, structured products backed by a basket of assets.

## Key Properties

- Up to **8 underlying assets** per vault (configurable via `MAX_ASSETS`)
- **Oracle-based share pricing** (Pyth Network or svs-oracle; auto-detected by discriminator)
- **Single-asset or proportional** deposits and redemptions
- **Authority-controlled rebalancing** via Jupiter aggregator CPI
- **Full SVS module compatibility**: fees, caps, locks, rewards, access

## Account Structures

### `MultiAssetVault`

PDA: `["multi_vault", vault_id.to_le_bytes()]`

| Field | Type | Description |
|-------|------|-------------|
| `authority` | `Pubkey` | Admin — add/remove assets, rebalance, pause |
| `shares_mint` | `Pubkey` | Share token mint (authority = vault PDA) |
| `total_shares` | `u64` | Total outstanding shares |
| `decimals_offset` | `u8` | Virtual offset (inflation-attack protection) |
| `bump` | `u8` | PDA bump seed |
| `paused` | `bool` | Emergency pause flag |
| `vault_id` | `u64` | Unique identifier |
| `num_assets` | `u8` | Active basket size (max 8) |
| `base_decimals` | `u8` | Oracle value precision (e.g. 6 = USD) |
| `_reserved` | `[u8; 64]` | Forward-compatibility padding |

### `AssetEntry`

PDA: `["asset_entry", vault_pda, asset_mint]`

| Field | Type | Description |
|-------|------|-------------|
| `vault` | `Pubkey` | Parent vault |
| `asset_mint` | `Pubkey` | SPL / Token-2022 mint |
| `asset_vault` | `Pubkey` | PDA-owned token account |
| `oracle` | `Pubkey` | Price oracle account |
| `target_weight_bps` | `u16` | Target allocation (10 000 = 100 %) |
| `asset_decimals` | `u8` | Mint precision |
| `index` | `u8` | Position in basket (0-indexed) |
| `bump` | `u8` | PDA bump seed |

## Instruction Set

| # | Instruction | Signer | Notes |
|---|-------------|--------|-------|
| 1 | `initialize` | Authority | Creates vault PDA + share mint |
| 2 | `add_asset` | Authority | Adds asset; checks oracle + weight sum |
| 3 | `remove_asset` | Authority | Closes `AssetEntry`; asset vault must be empty |
| 4 | `update_weights` | Authority | All weights via `remaining_accounts`; must sum to 10 000 |
| 5 | `deposit_single` | User | One asset in, shares out |
| 6 | `deposit_proportional` | User | All assets in at target weights, shares out |
| 7 | `redeem_single` | User | Shares in, one asset out |
| 8 | `redeem_proportional` | User | Shares in, proportional basket out |
| 9 | `rebalance` | Authority | Jupiter CPI swap |
| 10 | `pause` | Authority | Emergency freeze |
| 11 | `unpause` | Authority | Restore operations |
| 12 | `transfer_authority` | Authority | Admin handover |

## Pricing Model

```
total_value = sum_i(balance_i * oracle_price_i / 10^decimals_i)
shares_out  = deposit_value * (total_shares + offset) / (total_value + 1)
```

## Oracle Requirements

Auto-detects by 8-byte Anchor discriminator:

- **Pyth** `PriceUpdateV2`: staleness ≤ 300 s, confidence ≤ 1 %
- **svs-oracle**: same freshness contract

A single stale oracle blocks the entire vault.

## Module Compatibility

| Module | Status | Notes |
|--------|--------|-------|
| `svs-fees` | ✅ | Applied to base-unit deposit/redeem value |
| `svs-caps` | ✅ | Cap on `total_portfolio_value` |
| `svs-locks` | ✅ | Share-based lockups |
| `svs-rewards` | ✅ | Per-share rewards |
| `svs-access` | ✅ | Allow/deny lists |
| `svs-oracle` | ✅ | Used as mock in tests |

## Devnet Deployment

```bash
anchor deploy --provider.cluster devnet --program-name svs-8
# Program ID: SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j
```

## Testing

```bash
anchor test -- tests/svs-8.ts
```

## See Also

- [specs-SVS08.md](./specs-SVS08.md) — Full specification with pseudocode
- [SVS-1.md](./SVS-1.md) — Base single-asset vault
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design
- [MODULES.md](./MODULES.md) — Module system
