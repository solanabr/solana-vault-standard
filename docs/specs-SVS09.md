# SVS-9: Allocator Vault (Vault-of-Vaults)

## Status: Draft
## Authors: Superteam Brasil
## Date: 2026-03-06
## Base: MetaMorpho pattern — Allocator depositing into child vaults

---

## 1. Overview

SVS-9 is an allocator vault that deposits into multiple underlying SVS-compatible vaults. It holds shares of child vaults, and a curator rebalances allocations across them. Users interact with a single share token that represents a diversified position across strategies.

This vault type targets yield aggregation, risk-diversified lending, and multi-strategy funds. Think Yearn V3 or Morpho's MetaMorpho on Solana.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────┐
│  SVS-9 Allocator Vault                          │
│  ───────────────────                            │
│  User deposits USDC → gets allocator shares     │
│  Curator decides allocation across child vaults │
│                                                 │
│  Holds: shares of Child Vault A (SVS-1)         │
│         shares of Child Vault B (SVS-2)         │
│         shares of Child Vault C (SVS-1)         │
│         idle USDC (unallocated buffer)          │
└──────┬──────────┬──────────┬────────────────────┘
       │ CPI      │ CPI      │ CPI
       ▼          ▼          ▼
   ┌────────┐ ┌────────┐ ┌────────┐
   │ SVS-1  │ │ SVS-2  │ │ SVS-1  │
   │ Vault A│ │ Vault B│ │ Vault C│
   └────────┘ └────────┘ └────────┘
```

---

## 3. State

```rust
#[account]
pub struct AllocatorVault {
    pub authority: Pubkey,           // vault admin
    pub curator: Pubkey,             // allocation manager (can be different from authority)
    pub asset_mint: Pubkey,          // underlying asset (e.g., USDC) — same for all children
    pub shares_mint: Pubkey,         // allocator share token
    pub idle_vault: Pubkey,          // PDA-owned token account for unallocated assets
    pub total_shares: u64,
    pub num_children: u8,            // number of child vault allocations (max 10)
    pub idle_buffer_bps: u16,        // minimum % kept liquid for withdrawals (e.g., 500 = 5%)
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub _reserved: [u8; 64],
}
// seeds: ["allocator_vault", asset_mint, vault_id.to_le_bytes()]

#[account]
pub struct ChildAllocation {
    pub allocator_vault: Pubkey,
    pub child_vault: Pubkey,         // the SVS vault being allocated to
    pub child_program: Pubkey,       // program ID of the child vault (for CPI validation)
    pub child_shares_account: Pubkey, // allocator's share token account in the child vault
    pub target_weight_bps: u16,      // target allocation (e.g., 3000 = 30%)
    pub max_weight_bps: u16,         // hard cap (rebalance if exceeded)
    pub deposited_assets: u64,       // cumulative assets deposited into child
    pub index: u8,
    pub enabled: bool,               // curator can disable without removing
    pub bump: u8,
}
// seeds: ["child_allocation", allocator_vault_pda, child_vault_pda]
```

---

## 4. Total Assets Computation

```rust
/// Total assets = idle balance + sum of child vault positions
pub fn total_assets(
    idle_balance: u64,
    children: &[ChildAllocation],
    child_share_balances: &[u64],
    child_vault_states: &[Vault],    // child vault state to read share price
) -> Result<u64> {
    let mut total: u128 = idle_balance as u128;

    for i in 0..children.len() {
        if !children[i].enabled { continue; }
        // child_assets = child_shares * child_total_assets / child_total_shares
        let child_assets = convert_to_assets(
            child_share_balances[i],
            child_vault_states[i].total_shares(),
            child_vault_states[i].total_assets(),
            child_vault_states[i].offset(),
        )?;
        total = total.checked_add(child_assets as u128)?;
    }

    u64::try_from(total).map_err(|_| error!(VaultError::MathOverflow))
}
```

---

## 5. Instruction Set

| # | Instruction | Signer | Description |
|---|------------|--------|-------------|
| 1 | `initialize` | Authority | Creates AllocatorVault, share mint, idle vault |
| 2 | `add_child` | Authority | Registers a child vault allocation |
| 3 | `remove_child` | Authority | Removes child (must have zero shares) |
| 4 | `deposit` | User | Deposits assets → idle vault → mints allocator shares |
| 5 | `redeem` | User | Burns allocator shares → returns assets from idle vault |
| 6 | `allocate` | Curator | CPI deposit from idle vault into a child vault |
| 7 | `deallocate` | Curator | CPI redeem from child vault back to idle vault |
| 8 | `rebalance` | Curator | Deallocate from one child, allocate to another |
| 9 | `harvest` | Curator/Permissionless | Realize yield from child vaults into idle |
| 10 | `update_weights` | Authority | Update target/max weights for children |
| 11 | `set_curator` | Authority | Change curator address |
| 12 | `pause` / `unpause` | Authority | Emergency controls |
| 13 | `transfer_authority` | Authority | Transfer admin |

### 5.1 `deposit`

User deposits go to the idle vault. The curator allocates later.

```
deposit(assets: u64, min_shares_out: u64):
  ✓ vault not paused, assets > 0
  → Transfer assets from user to idle_vault
  → total = total_assets() (reads all child vaults)
  → shares = convert_to_shares(assets, total_shares, total, offset)
  → require!(shares >= min_shares_out)
  → Mint allocator shares to user
  → emit Deposit { vault, caller, assets, shares }
```

### 5.2 `redeem`

User redeems from idle buffer. If idle is insufficient, curator must deallocate first.

```
redeem(shares: u64, min_assets_out: u64):
  ✓ vault not paused, user has shares
  → total = total_assets()
  → assets = convert_to_assets(shares, total_shares, total, offset)
  → require!(assets >= min_assets_out)
  → require!(idle_vault.amount >= assets, InsufficientLiquidity)
  → Transfer assets from idle_vault to user
  → Burn allocator shares
  → emit Redeem { vault, caller, shares, assets }
```

### 5.3 `allocate`

Curator deploys idle assets to a child vault via CPI.

```
allocate(child_vault: Pubkey, amount: u64):
  ✓ signer == vault.curator
  ✓ ChildAllocation exists and is enabled
  ✓ After allocation, child weight <= max_weight_bps
  ✓ After allocation, idle_vault.amount >= idle_buffer_bps * total / 10000
  → CPI: child_vault_program::deposit(amount, 0) // 0 min_shares (slippage managed by curator)
  → child_allocation.deposited_assets += amount
  → emit Allocate { child_vault, amount, child_shares_received }
```

### 5.4 `deallocate`

Curator recalls assets from a child vault via CPI redeem.

```
deallocate(child_vault: Pubkey, shares: u64):
  ✓ signer == vault.curator
  ✓ ChildAllocation exists
  → CPI: child_vault_program::redeem(shares, 0)
  → assets received added to idle_vault
  → emit Deallocate { child_vault, shares, assets_received }
```

---

## 6. Curator Role

The curator is separated from the authority to enable specialized allocation management:

- **Authority:** Creates/removes children, sets weights, pauses vault, transfers authority.
- **Curator:** Allocates, deallocates, rebalances, harvests. Cannot change vault configuration.

This separation allows a DAO (authority) to set strategy parameters while a keeper bot or fund manager (curator) executes allocations within those parameters.

---

## 7. Idle Buffer

The `idle_buffer_bps` ensures a minimum percentage of total assets remains in the idle vault for instant withdrawals. The curator cannot allocate below this threshold.

```rust
pub fn check_idle_buffer(
    idle_after: u64,
    total_assets: u64,
    buffer_bps: u16,
) -> Result<()> {
    let min_idle = mul_div(total_assets, buffer_bps as u64, 10_000, Rounding::Ceiling)?;
    require!(idle_after >= min_idle, VaultError::InsufficientBuffer);
    Ok(())
}
```

If a large redemption depletes the idle buffer below threshold, the curator is expected to deallocate from children to replenish. The vault does NOT auto-deallocate — that would require CPI to arbitrary programs in the user's redeem transaction, which is unpredictable in compute cost.

---

## 8. Child Vault Compatibility

SVS-9 can allocate to ANY vault program that implements the standard SVS deposit/redeem interface:

```rust
// Minimum required CPI interface for child vaults:
pub fn deposit(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()>
pub fn redeem(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()>
```

This includes SVS-1, SVS-2, SVS-5, SVS-7, and even other SVS-9 vaults (recursive allocation). The `child_program` field on `ChildAllocation` is validated on every CPI to prevent program substitution attacks.

**Excluded:** SVS-10 (async) and SVS-11 (credit) cannot be children because their deposit/redeem is non-atomic. SVS-3/SVS-4/SVS-6 (confidential) cannot be children because the allocator cannot prove encrypted balances for aggregate total_assets computation.

---

## 9. Weight Enforcement

Unlike SVS-8 (multi-asset) where weights must sum to 10000, the allocator uses weights as targets with tolerance:

```
sum(target_weight_bps) + idle_buffer_bps == 10_000

// Actual weights can drift. max_weight_bps prevents excessive concentration.
// Curator rebalances to bring weights back toward targets.
```

---

## 10. Module Compatibility

- **svs-fees:** Management fee on total_assets (including child positions). Performance fee on allocator share price appreciation. Entry/exit fees on user deposits/redeems.
- **svs-caps:** Global cap on total_assets. Per-user cap on allocator shares value.
- **svs-locks:** Applied to allocator shares. Users locked from redeeming for a period.
- **svs-rewards:** Allocator can distribute secondary rewards to allocator share holders.
- **svs-access:** Gate who can deposit into the allocator.

---

## 11. Compute Budget Considerations

`total_assets()` reads state from all child vaults. With 10 children, that's 10 account reads + 10 mul_div operations. Estimated ~5,000 CU for the computation alone, plus account deserialization overhead (~1,000 CU per account).

Total compute for a deposit with 10 children: ~30-40k CU. Well within budget. The CPI calls in `allocate`/`deallocate` are more expensive (~50-100k CU each) but those are curator-only operations, not user-facing.
