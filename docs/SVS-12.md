# SVS-12: Tranched Vault

## Overview

SVS-12 implements a synchronous tranched vault with 2-4 tranches sharing a single asset pool. Each tranche has independent Token-2022 share tokens, configurable priority, subordination requirements, yield targets, and capacity caps. Yield is distributed via a waterfall mechanism; losses are absorbed bottom-up (junior first, senior last).

Designed for structured credit products (CLO-style senior/mezzanine/junior), real-world asset pools, and risk-segmented investment vehicles.

## Architecture

```
┌─────────────────────────────────────┐
│         TranchedVault (PDA)         │
│  authority, manager, asset_mint    │
│  total_assets, waterfall_mode      │
│  priority_bitmap, num_tranches     │
├──────────┬──────────┬──────────────┤
│ Tranche0 │ Tranche1 │ Tranche2..3  │
│ (senior) │ (junior) │  (optional)  │
│ shares0  │ shares1  │  shares2..3  │
└──────────┴──────────┴──────────────┘
          ▼ single pool ▼
     ┌───────────────────┐
     │    Asset Vault     │
     │  (SPL Token ATA)   │
     └───────────────────┘
```

## Account Structures

### TranchedVault (280 bytes + 8 disc = 288 total)

| Field | Type | Description |
|-------|------|-------------|
| authority | Pubkey | Admin authority |
| manager | Pubkey | Manager for yield/loss/rebalance |
| asset_mint | Pubkey | Underlying asset mint |
| asset_vault | Pubkey | Asset token account (ATA) |
| total_assets | u64 | Sum of all tranche allocations |
| num_tranches | u8 | Active tranche count (2-4) |
| decimals_offset | u8 | 9 - asset_decimals (inflation protection) |
| bump | u8 | Vault PDA bump |
| paused | bool | Emergency pause flag |
| wiped | bool | True when total_assets = 0 from loss |
| priority_bitmap | u8 | Bit i set = priority i claimed |
| vault_id | u64 | Unique vault identifier |
| waterfall_mode | enum | Sequential or ProRataYieldSequentialLoss |
| nav_oracle | Option\<Pubkey\> | Reserved for oracle integration |
| oracle_program | Option\<Pubkey\> | Reserved for oracle program |
| _reserved | [u8; 63] | Future expansion |

### Tranche (122 bytes + 8 disc)

| Field | Type | Description |
|-------|------|-------------|
| vault | Pubkey | Parent vault address |
| shares_mint | Pubkey | Token-2022 shares mint |
| shares_mint_bump | u8 | Shares mint PDA bump |
| total_shares | u64 | Outstanding shares |
| total_assets_allocated | u64 | Assets allocated to this tranche |
| priority | u8 | 0 = senior, higher = junior |
| subordination_bps | u16 | Required junior capital (basis points) |
| target_yield_bps | u16 | Target yield for sequential waterfall |
| cap_bps | u16 | Max allocation as % of total_assets |
| index | u8 | Creation index (0-3) |
| bump | u8 | Tranche PDA bump |
| _reserved | [u8; 31] | Future expansion |

## PDA Seeds

| Account | Seeds |
|---------|-------|
| TranchedVault | `["tranched_vault", asset_mint, vault_id_le_bytes]` |
| Tranche | `["tranche", vault, [index]]` |
| Shares Mint | `["shares", vault, [index]]` |

## Waterfall Modes

### Sequential (mode=0)
Senior tranches receive their target yield first. Residual flows to the next tranche. The most junior tranche gets whatever remains. This is the traditional CLO pattern.

```
Total yield = 200, Senior target = 5% of 3000 = 150
Senior gets: min(150, 200) = 150
Junior gets: 200 - 150 = 50
```

### ProRata Yield, Sequential Loss (mode=1)
Yield is distributed proportionally to each tranche's allocation. Losses are still absorbed bottom-up (junior first). Useful for diversified pools where risk-adjusted returns are preferred.

## Instruction Reference

### initialize
Creates the tranched vault PDA and its asset vault ATA.

**Params**: `vault_id: u64`, `waterfall_mode: u8`

### add_tranche
Creates a tranche PDA and its Token-2022 shares mint. Priority uniqueness is enforced via the bitmap.

**Params**: `priority: u8`, `subordination_bps: u16`, `target_yield_bps: u16`, `cap_bps: u16`

### deposit
Deposits assets into a specific tranche. Computes shares via `convert_to_shares` (floor rounding). Enforces cap and subordination checks on the post-state.

**Params**: `assets: u64`, `min_shares_out: u64`

### redeem
Burns shares and returns assets from a specific tranche. Uses `convert_to_assets` (floor rounding). Enforces subordination check on post-state.

**Params**: `shares: u64`, `min_assets_out: u64`

### distribute_yield
Manager deposits yield tokens into the asset vault. The waterfall distributes yield across all tranches according to the vault's waterfall mode. Uses a phased borrow pattern to avoid Rust borrow checker issues.

**Params**: `total_yield: u64`

### record_loss
Manager records an asset loss. Losses are absorbed bottom-up: junior absorbs first, then mezzanine, then senior. Sets `wiped = true` if total_assets reaches 0. No subordination check after loss (by design).

**Params**: `total_loss: u64`

### rebalance_tranches
Manager moves allocation between two tranches (accounting only, no token movement). Subordination check on post-state.

**Params**: `amount: u64`

### pause / unpause
Authority pauses or unpauses the vault. Paused vaults reject deposits, redeems, yield distributions, and losses.

### transfer_authority
Transfers vault authority to a new address.

### set_manager
Sets a new manager for yield/loss/rebalance operations.

### update_tranche_config
Authority updates tranche parameters (target_yield_bps, cap_bps, subordination_bps). Uses `Option<u16>` — None leaves field unchanged. Subordination check after update.

## Key Invariants

1. **`vault.total_assets == sum(tranche[i].total_assets_allocated)`** — maintained by every instruction
2. **Priority uniqueness** — enforced via `priority_bitmap` in `add_tranche`
3. **Subordination** — `junior_allocation >= (total_assets * subordination_bps) / 10000` checked after deposit, redeem, rebalance, and config update (not after loss)
4. **Cap enforcement** — `tranche_allocation <= (total_assets * cap_bps) / 10000` checked after deposit
5. **Vault-favoring rounding** — floor for both deposit (fewer shares) and redeem (fewer assets)
6. **Tranche count validation** — every multi-tranche instruction requires `count(provided tranches) == vault.num_tranches`

## Events

| Event | Emitted By |
|-------|-----------|
| VaultInitialized | initialize |
| TrancheAdded | add_tranche |
| TrancheDeposit | deposit |
| TrancheRedeem | redeem |
| YieldDistributed | distribute_yield |
| LossRecorded | record_loss |
| TrancheRebalanced | rebalance_tranches |
| TrancheConfigUpdated | update_tranche_config |
| VaultPaused | pause |
| VaultUnpaused | unpause |
| AuthorityTransferred | transfer_authority |
| ManagerChanged | set_manager |

## Error Codes

| Error | Description |
|-------|-------------|
| ZeroAmount | Amount must be > 0 |
| VaultPaused | Vault is paused |
| VaultWiped | Vault was wiped by total loss |
| Unauthorized | Caller is not authority/manager |
| MaxTranchesReached | Already at 4 tranches |
| DuplicatePriority | Priority already assigned |
| InvalidAssetDecimals | Asset decimals > 9 |
| InvalidWaterfallMode | Mode must be 0 or 1 |
| MathOverflow | Arithmetic overflow |
| SlippageExceeded | Output below minimum |
| InsufficientShares | User has insufficient shares |
| InsufficientLiquidity | Asset vault has insufficient funds |
| InsufficientAllocation | Tranche has insufficient allocation |
| CapExceeded | Deposit would exceed tranche cap |
| SubordinationBreach | Post-state violates subordination |
| WrongTrancheCount | Not all tranches provided |
| TrancheVaultMismatch | Tranche doesn't belong to vault |
| TotalLoss | Loss exceeds total assets |
| InvalidYieldConfig | yield_bps > 10000 |
| InvalidCapConfig | cap_bps must be 1-10000 |
| InvalidSubordinationConfig | subordination_bps > 10000 |
| VaultNotPaused | Vault is not paused (for unpause) |

## SDK Usage

```typescript
import { TranchedVault } from "@stbr/solana-vault";

// Create vault
const vault = await TranchedVault.create(program, {
  assetMint,
  vaultId: 1,
  waterfallMode: 0, // Sequential
});

// Add tranches
await vault.addTranche(authority, {
  priority: 0,
  subordinationBps: 2000,
  targetYieldBps: 500,
  capBps: 6000,
});
await vault.addTranche(authority, {
  priority: 1,
  subordinationBps: 0,
  targetYieldBps: 0,
  capBps: 10000,
});

// Deposit
await vault.deposit(user, 1, {
  assets: new BN(1000_000000),
  minSharesOut: new BN(0),
});

// Distribute yield
await vault.distributeYield(manager, new BN(200_000000));

// Record loss
await vault.recordLoss(manager, new BN(500_000000));

// Redeem
await vault.redeem(user, 1, {
  shares: new BN(100_000000000),
  minAssetsOut: new BN(0),
});
```

## CLI Usage

```bash
# Initialize
solana-vault tranched initialize --asset-mint <MINT> --vault-id 1 --waterfall 0

# Add tranches
solana-vault tranched add-tranche --asset-mint <MINT> --priority 0 --sub-bps 2000 --yield-bps 500 --cap-bps 6000
solana-vault tranched add-tranche --asset-mint <MINT> --priority 1 --sub-bps 0 --cap-bps 10000

# Deposit/Redeem
solana-vault tranched deposit --asset-mint <MINT> -t 1 -a 1000000000
solana-vault tranched redeem --asset-mint <MINT> -t 1 -s 1000000000000

# Manager operations
solana-vault tranched distribute-yield --asset-mint <MINT> -a 200000000
solana-vault tranched record-loss --asset-mint <MINT> -a 500000000
solana-vault tranched rebalance --asset-mint <MINT> --from 1 --to 0 -a 50000000

# Admin
solana-vault tranched admin pause --asset-mint <MINT>
solana-vault tranched admin update-tranche --asset-mint <MINT> -t 0 --yield-bps 1000

# Info
solana-vault tranched info --asset-mint <MINT>
```
