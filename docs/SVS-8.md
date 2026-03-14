# SVS-8: Multi-Asset Basket Vault

> **Status:** Implementation complete — Devnet deployed
> **Program ID:** `SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j`
> **Spec:** [specs-SVS08.md](./specs-SVS08.md)

## Overview

SVS-8 implements a **multi-asset basket vault**: a single share token representing proportional ownership of up to 8 underlying SPL tokens. It is the Solana-native analog of ERC-7575 and an extension of the core SVS vault architecture.

**Use cases:** index funds, treasury management, diversified yield strategies, structured products backed by a basket of assets.

## Key Properties

- Up to **8 underlying assets** per vault (configurable via `MAX_ASSETS`)
- **Oracle-based share pricing** — supports Pyth Network `PriceUpdateV2` and svs-oracle (auto-detected by Anchor discriminator)
- **Single-asset or proportional** deposits and redemptions
- **Authority-controlled rebalancing** via Jupiter aggregator CPI
- **Full SVS module compatibility**: fees, caps, locks, rewards, access
- **Inflation attack protection** via virtual decimal offset (same mechanism as SVS-1)

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
| 9 | `rebalance` | Authority | Jupiter CPI swap to match target weights |
| 10 | `pause` | Authority | Emergency freeze |
| 11 | `unpause` | Authority | Restore operations |
| 12 | `transfer_authority` | Authority | Admin handover |

## Pricing Model

```
total_value = Σ (balance_i × oracle_price_i / 10^decimals_i)

# Deposit:
shares_out = deposit_value × (total_shares + 10^offset) / (total_value + 1)

# Redeem:
assets_out = shares × (total_value + 1) / (total_shares + 10^offset)
```

All conversions use vault-favoring rounding (floor on deposit, ceiling on redeem).

## Oracle Requirements

Auto-detects oracle type by 8-byte Anchor discriminator:

- **Pyth `PriceUpdateV2`**: staleness ≤ 300 s, confidence ≤ 1 %
- **svs-oracle**: same freshness contract; used in local/unit tests

A single stale oracle blocks the entire vault. This is by design — partial price data could allow incorrect valuations.

## Module Compatibility

| Module | Status | Notes |
|--------|--------|-------|
| `svs-fees` | ✅ Full | Applied to base-unit deposit/redeem value |
| `svs-caps` | ✅ Full | Cap on `total_portfolio_value` and per-user |
| `svs-locks` | ✅ Full | Share-based lockups (no change needed) |
| `svs-rewards` | ✅ Full | Per-share rewards; basket composition opaque |
| `svs-access` | ✅ Full | Allow/deny lists on deposit/redeem |
| `svs-oracle` | ✅ Full | Used as mock in unit tests; Pyth on devnet |

Build with `--features modules` to enable all module hooks.

## Remaining Accounts Convention

Deposit/redeem instructions that need total portfolio value use `remaining_accounts`:

- **deposit_single / redeem_single**: `[AssetEntry, asset_vault, oracle] × num_assets`
- **deposit_proportional / redeem_proportional**: `[AssetEntry, asset_vault, oracle, user_token_account] × num_assets`
- **update_weights**: `[AssetEntry (writable)] × num_assets` — in index order

## Rebalance (Jupiter CPI)

Authority-initiated rebalancing uses Jupiter v6 aggregator. The vault PDA signs the swap via `invoke_signed`. Post-swap, the instruction verifies `received >= minimum_out` to enforce slippage protection.

```
# Example (CLI)
solana-vault basket rebalance 800001 \
  --from <USDC_MINT> --to <SOL_MINT> \
  --min-out 1000000 \
  --route <JUPITER_ROUTE_HEX> --yes
```

## Devnet Deployment

```bash
anchor deploy --provider.cluster devnet --program-name svs-8
# Program ID: SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j
```

Example transactions (devnet):
- Vault initialization: see PR description for live tx links
- Full lifecycle: run `npx ts-node scripts/svs-8/e2e-svs8.ts`

## SDK Usage

```ts
import { BasketVault, multiVaultPda, assetEntryPda } from "@stbr/solana-vault";
import { BN } from "@coral-xyz/anchor";

// Initialize a new basket vault
const basket = await BasketVault.create(program, authority, { vaultId: new BN(1) });

// Add assets
await basket.addAsset(authority, {
  assetMint: usdcMint,
  oracle: pythUsdcFeed,
  targetWeightBps: 6000, // 60%
});
await basket.addAsset(authority, {
  assetMint: solMint,
  oracle: pythSolFeed,
  targetWeightBps: 4000, // 40%
});

// Deposit single asset
await basket.depositSingle(user, {
  assetMint: usdcMint,
  amount: new BN(1_000_000),
  minSharesOut: new BN(0),
  oracle: pythUsdcFeed,
  basketAssets: basket.assets.map(a => ({ assetMint: a.assetMint, oracle: a.oracle })),
});
```

## CLI Usage

```bash
# Initialize vault
solana-vault basket init 800001 --decimals-offset 6

# Add assets
solana-vault basket add-asset 800001 <USDC_MINT> <PYTH_USDC_ORACLE> 6000 --yes
solana-vault basket add-asset 800001 <SOL_MINT> <PYTH_SOL_ORACLE> 4000 --yes

# Check state
solana-vault basket info 800001

# Deposit
solana-vault basket deposit 800001 --asset <USDC_MINT> --amount 1000000 \
  --oracle <PYTH_USDC_ORACLE> --min-shares 0 --yes

# Redeem
solana-vault basket redeem 800001 --shares 500000 --asset-index 0 --yes
```

## Testing

```bash
# Unit tests (Anchor bankrun)
anchor test -- tests/svs-8.ts

# E2E tests (devnet)
export RPC_URL="https://api.devnet.solana.com"
npx ts-node scripts/svs-8/e2e-svs8.ts

# Fuzz tests (Trident)
trident fuzz run fuzz_svs8
```

## Compute Unit Estimates

| Instruction | Approximate CU | Notes |
|-------------|---------------|-------|
| `initialize` | ~25,000 | Create vault + shares mint |
| `add_asset` | ~35,000 | Create AssetEntry + asset_vault |
| `deposit_single` (2 assets) | ~55,000 | 2 oracle reads + transfer + mint |
| `deposit_proportional` (2 assets) | ~85,000 | 2 transfers + 2 oracle reads |
| `redeem_single` (2 assets) | ~60,000 | burn + transfer + oracle reads |
| `redeem_proportional` (2 assets) | ~90,000 | 2 transfers + burn |
| `rebalance` | ~100,000+ | Jupiter CPI (varies by route) |

## Limitations

- **Max 8 assets per basket** — practical limit from account budget and compute units
- **Oracle dependency** — stale price on any asset blocks the entire vault
- **No atomic rebalancing** — rebalance swaps are separate transactions (use Jupiter for single-tx routes)
- **Weight drift** — single-asset deposits cause portfolio drift from target; authority must periodically rebalance

## See Also

- [specs-SVS08.md](./specs-SVS08.md) — Full specification with pseudocode
- [SVS-1.md](./SVS-1.md) — Base single-asset vault (architecture reference)
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design
- [MODULES.md](./MODULES.md) — Module system docs
- [SDK.md](./SDK.md) — SDK architecture and conventions
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
