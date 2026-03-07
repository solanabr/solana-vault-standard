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

**Implementation:** Build with `--features modules`. Module config PDAs passed via `remaining_accounts`.

- **svs-fees:** Management fee on total_assets (including child positions). Performance fee on allocator share price appreciation. Entry/exit fees on user deposits/redeems.
- **svs-caps:** Global cap on total_assets. Per-user cap on allocator shares value.
- **svs-locks:** Applied to allocator shares. Users locked from redeeming for a period.
- **svs-rewards:** Allocator can distribute secondary rewards to allocator share holders.
- **svs-access:** Gate who can deposit into the allocator.

---

## 11. Compute Budget Considerations

`total_assets()` reads state from all child vaults. With 10 children, that's 10 account reads + 10 mul_div operations. Estimated ~5,000 CU for the computation alone, plus account deserialization overhead (~1,000 CU per account).

Total compute for a deposit with 10 children: ~30-40k CU. Well within budget. The CPI calls in `allocate`/`deallocate` are more expensive (~50-100k CU each) but those are curator-only operations, not user-facing.

---

## 12. Child Vault Compatibility Matrix

| Child Variant | Compatible | Reason |
|---------------|------------|--------|
| **SVS-1** | ✅ Yes | Live balance, synchronous deposit/redeem |
| **SVS-2** | ✅ Yes | Stored balance, synchronous deposit/redeem |
| **SVS-3** | ❌ No | Encrypted balances — cannot read child total_assets |
| **SVS-4** | ❌ No | Encrypted balances — cannot read child total_assets |
| **SVS-5** | ✅ Yes | Streaming yield, synchronous ops (after checkpoint) |
| **SVS-6** | ❌ No | Encrypted + streaming — cannot read child total_assets |
| **SVS-7** | ✅ Yes | Native SOL, synchronous ops |
| **SVS-8** | ⚠️ Partial | Requires oracle calls for child value — high CU cost |
| **SVS-9** | ⚠️ Partial | Nested allocators work but add complexity |
| **SVS-10** | ❌ No | Async — deposit/redeem not atomic (request→fulfill→claim) |
| **SVS-11** | ❌ No | Async + KYC — not suitable for programmatic CPI |
| **SVS-12** | ⚠️ Partial | Per-tranche allocation complex; requires selecting specific tranche |

**Core Rule**: Allocator children must have:
1. **Synchronous deposit/redeem** — atomic CPI must complete in one transaction
2. **Readable total_assets** — no encryption that prevents balance reading
3. **Standard interface** — `deposit(assets, min_shares_out)` and `redeem(shares, min_assets_out)`

---

## 13. Child CPI Validation

Before executing CPI to a child vault, the allocator validates the child program to prevent program substitution attacks:

```rust
/// Validate child vault before CPI
pub fn validate_child_for_cpi(
    child_allocation: &ChildAllocation,
    child_vault_info: &AccountInfo,
    child_program_info: &AccountInfo,
) -> Result<()> {
    // 1. Verify child program matches registered program
    require!(
        child_program_info.key() == child_allocation.child_program,
        VaultError::InvalidChildProgram
    );

    // 2. Verify child vault account is owned by the registered program
    require!(
        child_vault_info.owner == &child_allocation.child_program,
        VaultError::InvalidChildProgram
    );

    // 3. Verify child vault PDA matches registered address
    require!(
        child_vault_info.key() == child_allocation.child_vault,
        VaultError::InvalidChildVault
    );

    // 4. Validate discriminator matches expected vault type
    let data = child_vault_info.try_borrow_data()?;
    let discriminator = &data[..8];

    // SVS-1 Vault discriminator
    const SVS1_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];

    // Accept SVS-1 or SVS-2 vaults (same struct, different program)
    require!(
        discriminator == &SVS1_DISCRIMINATOR,
        VaultError::UnsupportedChildVariant
    );

    // 5. Verify child allocation is enabled
    require!(
        child_allocation.enabled,
        VaultError::ChildAllocationDisabled
    );

    Ok(())
}

/// Read total_assets from a child vault (no CPI needed, direct deserialization)
pub fn read_child_total_assets(
    child_vault_info: &AccountInfo,
) -> Result<u64> {
    let data = child_vault_info.try_borrow_data()?;

    // Vault struct layout (after 8-byte discriminator):
    // authority: 32, asset_mint: 32, shares_mint: 32, asset_vault: 32
    // → total_assets at offset 136
    const TOTAL_ASSETS_OFFSET: usize = 8 + 32 + 32 + 32 + 32;

    let total_assets_bytes: [u8; 8] = data[TOTAL_ASSETS_OFFSET..TOTAL_ASSETS_OFFSET + 8]
        .try_into()
        .map_err(|_| VaultError::InvalidAccountData)?;

    Ok(u64::from_le_bytes(total_assets_bytes))
}
```

---

## 14. harvest() Implementation

The `harvest` instruction collects yield from all child vaults by redeeming the profit portion of shares:

```rust
/// Collect yield from all child vaults
pub fn harvest(ctx: Context<Harvest>) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let mut total_harvested = 0u64;

    // Children passed as remaining_accounts in groups of 4:
    // [ChildAllocation, child_vault_state, child_shares_account, child_vault_program]
    let chunks = ctx.remaining_accounts.chunks_exact(4);

    for (i, child_accounts) in chunks.enumerate() {
        let child_allocation_info = &child_accounts[0];
        let child_vault_info = &child_accounts[1];
        let child_shares_info = &child_accounts[2];
        let child_program_info = &child_accounts[3];

        // 1. Deserialize child allocation
        let child_allocation: Account<ChildAllocation> =
            Account::try_from(child_allocation_info)?;

        if !child_allocation.enabled {
            continue;
        }

        // 2. Validate child program
        validate_child_for_cpi(&child_allocation, child_vault_info, child_program_info)?;

        // 3. Read current position value
        let child_total_assets = read_child_total_assets(child_vault_info)?;
        let our_shares = get_token_account_balance(child_shares_info)?;

        // Get child total_shares from mint
        let child_vault: Account<Vault> = Account::try_from(child_vault_info)?;
        let child_total_shares = child_vault.total_shares;
        let child_offset = 10u64.pow(child_vault.decimals_offset as u32);

        let our_value = convert_to_assets(
            our_shares,
            child_total_shares,
            child_total_assets,
            child_offset,
        )?;

        // 4. Calculate yield (current value - cost basis)
        let cost_basis = child_allocation.deposited_assets;
        let yield_amount = our_value.saturating_sub(cost_basis);

        if yield_amount == 0 {
            continue;  // No yield to harvest
        }

        // 5. Calculate shares to redeem for yield portion
        let shares_to_redeem = convert_to_shares(
            yield_amount,
            child_total_shares,
            child_total_assets,
            child_offset,
        )?;

        if shares_to_redeem == 0 {
            continue;  // Rounding resulted in zero shares
        }

        // 6. CPI: Redeem yield portion from child vault
        let allocator_seeds = &[
            b"allocator_vault",
            allocator.asset_mint.as_ref(),
            &allocator.vault_id.to_le_bytes(),
            &[allocator.bump],
        ];

        let cpi_accounts = child_vault::cpi::accounts::Redeem {
            vault: child_vault_info.clone(),
            // ... other required accounts
        };

        child_vault::cpi::redeem(
            CpiContext::new_with_signer(
                child_program_info.clone(),
                cpi_accounts,
                &[allocator_seeds],
            ),
            shares_to_redeem,
            0,  // min_assets_out (curator accepts any, slippage managed externally)
        )?;

        // 7. Update state
        // Note: cost_basis stays the same (we harvested yield, not principal)
        total_harvested = total_harvested.checked_add(yield_amount)?;

        emit!(ChildHarvested {
            allocator: allocator.key(),
            child_vault: child_allocation.child_vault,
            shares_redeemed: shares_to_redeem,
            assets_received: yield_amount,
        });
    }

    // 8. Harvested assets now in idle_vault
    // total_assets doesn't change (value was already counted in position)

    emit!(Harvest {
        allocator: allocator.key(),
        total_harvested,
    });

    Ok(())
}
```

---

## 15. Compute Unit Estimates

| Instruction | Approximate CU | Notes |
|-------------|---------------|-------|
| `initialize` | ~30,000 | Create allocator + shares mint + idle vault |
| `add_child` | ~25,000 | Create ChildAllocation PDA |
| `deposit` | ~40,000 | Read N child vaults + transfer + mint |
| `redeem` | ~35,000 | Read N child vaults + burn + transfer |
| `allocate` | ~60,000 | CPI deposit to child vault |
| `deallocate` | ~70,000 | CPI redeem from child vault |
| `harvest` | ~80,000 × N | CPI redeem from each child with yield |
| `rebalance` | ~150,000 | deallocate + allocate in one tx |

**With 10 children**: Deposit/redeem operations cost ~40-50k CU. Well within the 200k default limit.

---

## See Also

- [SVS-1](./SVS-1.md) — Base synchronous vault (compatible child)
- [SVS-2](./SVS-2.md) — Stored balance vault (compatible child)
- [specs-modules.md](./specs-modules.md) — Module integration
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design
