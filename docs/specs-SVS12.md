# SVS-12: Tranched Vault

## Status: Draft
## Authors: Superteam Brasil
## Date: 2026-03-06
## Base: Senior/Junior waterfall — Multi-tranche vault with loss absorption

---

## 1. Overview

SVS-12 issues multiple share classes (tranches) from a single underlying asset pool. Each tranche has a different risk/return profile enforced by an on-chain waterfall: junior tranches absorb losses first, senior tranches get paid first. A single pool of assets backs all tranches, with the distribution governed by subordination ratios and priority rules.

This vault type targets structured credit products (CLOs, CDOs, FIDCs), insurance pools, and any product where investors can choose their position in the capital structure.

---

## 2. Tranche Model

```
┌─────────────────────────────────────────────────┐
│  SVS-12 Tranched Vault                          │
│  ───────────────────                            │
│  Single asset pool (e.g., USDC)                 │
│                                                 │
│  ┌──────────────────────────────────┐           │
│  │  Senior Tranche (AAA)            │ Paid 1st  │
│  │  Lower yield, protected capital  │ Loss last │
│  │  Share mint: SENIOR_SHARES       │           │
│  └──────────────────────────────────┘           │
│  ┌──────────────────────────────────┐           │
│  │  Mezzanine Tranche (BBB)        │ Paid 2nd  │
│  │  Medium yield, medium risk       │           │
│  │  Share mint: MEZZ_SHARES         │           │
│  └──────────────────────────────────┘           │
│  ┌──────────────────────────────────┐           │
│  │  Junior Tranche (Equity)         │ Paid last │
│  │  Highest yield, first loss       │ Loss 1st  │
│  │  Share mint: JUNIOR_SHARES       │           │
│  └──────────────────────────────────┘           │
└─────────────────────────────────────────────────┘
```

---

## 3. State

```rust
#[account]
pub struct TranchedVault {
    pub authority: Pubkey,
    pub manager: Pubkey,
    pub asset_mint: Pubkey,
    pub asset_vault: Pubkey,         // single PDA-owned token account for all assets
    pub total_assets: u64,           // total pool value
    pub num_tranches: u8,            // 2-4 tranches supported
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,

    // ── Waterfall config ──
    pub waterfall_mode: WaterfallMode,

    // ── Optional oracle (for async/credit variants) ──
    pub nav_oracle: Option<Pubkey>,
    pub oracle_program: Option<Pubkey>,

    pub _reserved: [u8; 64],
}
// seeds: ["tranched_vault", asset_mint, vault_id.to_le_bytes()]

#[account]
pub struct Tranche {
    pub vault: Pubkey,
    pub shares_mint: Pubkey,         // each tranche has its own share token
    pub total_shares: u64,
    pub total_assets_allocated: u64, // this tranche's share of total_assets
    pub priority: u8,                // 0 = highest priority (senior), N = lowest (junior)
    pub subordination_bps: u16,      // min % of pool that must be junior to this tranche
    pub target_yield_bps: u16,       // annual target yield for this tranche (0 = equity/variable)
    pub cap_bps: u16,                // max % of total pool this tranche can be (10000 = uncapped)
    pub index: u8,
    pub bump: u8,
}
// seeds: ["tranche", vault_pda, priority.to_le_bytes()]

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum WaterfallMode {
    /// Yield distributed top-down: senior gets target yield first,
    /// remainder flows to next tranche, equity gets residual.
    Sequential,
    /// Yield distributed proportionally but losses absorbed bottom-up.
    /// All tranches earn the same rate until losses occur.
    ProRataYieldSequentialLoss,
}
```

---

## 4. Waterfall Math

### 4.1 Sequential Waterfall (Standard CLO)

Yield is distributed top-down. Senior tranche gets its target yield first, then mezzanine, then junior gets whatever remains.

```rust
pub fn distribute_yield_sequential(
    total_yield: u64,
    tranches: &[Tranche],  // sorted by priority (0 = senior)
) -> Result<Vec<u64>> {
    let mut remaining = total_yield;
    let mut distributions = vec![0u64; tranches.len()];

    for i in 0..tranches.len() {
        if tranches[i].target_yield_bps == 0 {
            // Equity tranche gets all remaining
            distributions[i] = remaining;
            remaining = 0;
            break;
        }
        let entitled = mul_div(
            tranches[i].total_assets_allocated,
            tranches[i].target_yield_bps as u64,
            10_000,
            Rounding::Floor,
        )?;
        let actual = std::cmp::min(entitled, remaining);
        distributions[i] = actual;
        remaining = remaining.checked_sub(actual)?;
    }

    // Any remaining after all tranches goes to equity (last tranche)
    if remaining > 0 {
        let last = distributions.len() - 1;
        distributions[last] = distributions[last].checked_add(remaining)?;
    }

    Ok(distributions)
}
```

### 4.2 ProRata Waterfall (Alternative Mode)

ProRata distributes yield proportionally across all tranches, but losses are still absorbed bottom-up. This mode is used when all tranches should earn the same rate during normal operations.

```rust
/// ProRata yield distribution with sequential loss absorption
pub fn distribute_yield_prorata(
    total_yield: u64,
    tranches: &[Tranche],
) -> Result<Vec<u64>> {
    // Calculate total principal across all tranches
    let total_principal: u64 = tranches
        .iter()
        .map(|t| t.total_assets_allocated)
        .sum();

    if total_principal == 0 {
        return Ok(vec![0u64; tranches.len()]);
    }

    let mut distributions = Vec::with_capacity(tranches.len());

    // Distribute yield proportionally to each tranche's share of total assets
    for tranche in tranches.iter() {
        let tranche_share = mul_div(
            total_yield,
            tranche.total_assets_allocated,
            total_principal,
            Rounding::Floor,
        )?;
        distributions.push(tranche_share);
    }

    // Handle rounding remainder — give to equity (last tranche)
    let distributed: u64 = distributions.iter().sum();
    let remainder = total_yield.saturating_sub(distributed);
    if remainder > 0 && !distributions.is_empty() {
        let last = distributions.len() - 1;
        distributions[last] = distributions[last].checked_add(remainder)?;
    }

    Ok(distributions)
}
```

### 4.3 Waterfall Mode Comparison

| Aspect | Sequential | ProRata |
|--------|-----------|---------|
| **Yield distribution** | Senior first, then mezz, then junior | All tranches proportionally |
| **Loss absorption** | Junior first, then mezz, then senior | Same (junior first) |
| **Senior yield** | Predictable (target_yield_bps) | Variable (pool-dependent) |
| **Junior yield** | Residual (high upside) | Same rate as senior |
| **Use case** | CLOs, CDOs, FIDCs | Risk-sharing pools, insurance |

### 4.4 Loss Absorption (Bottom-Up)

Losses are absorbed starting from the lowest-priority tranche (junior/equity) upward.

```rust
pub fn absorb_losses(
    total_loss: u64,
    tranches: &mut [Tranche],  // sorted by priority (0 = senior)
) -> Result<()> {
    let mut remaining_loss = total_loss;

    // Iterate from lowest priority (junior) to highest (senior)
    for i in (0..tranches.len()).rev() {
        if remaining_loss == 0 { break; }

        let absorbed = std::cmp::min(remaining_loss, tranches[i].total_assets_allocated);
        tranches[i].total_assets_allocated = tranches[i]
            .total_assets_allocated
            .checked_sub(absorbed)?;
        remaining_loss = remaining_loss.checked_sub(absorbed)?;

        emit!(LossAbsorbed {
            tranche_priority: tranches[i].priority,
            amount_absorbed: absorbed,
            remaining_assets: tranches[i].total_assets_allocated,
        });
    }

    if remaining_loss > 0 {
        // All tranches wiped — total loss exceeds pool
        return Err(error!(VaultError::TotalLoss));
    }
    Ok(())
}
```

### 4.3 Subordination Enforcement

```rust
/// Check that subordination ratios are maintained after a deposit or withdrawal.
/// subordination_bps = min % of pool that must rank below this tranche.
pub fn check_subordination(
    tranches: &[Tranche],
    total_assets: u64,
) -> Result<()> {
    for i in 0..tranches.len() {
        let junior_assets: u64 = tranches[i+1..]
            .iter()
            .map(|t| t.total_assets_allocated)
            .sum();
        let required = mul_div(
            total_assets,
            tranches[i].subordination_bps as u64,
            10_000,
            Rounding::Ceiling,
        )?;
        require!(junior_assets >= required, VaultError::SubordinationBreach);
    }
    Ok(())
}
```

---

## 5. Instruction Set

| # | Instruction | Signer | Description |
|---|------------|--------|-------------|
| 1 | `initialize` | Authority | Creates TranchedVault PDA and asset vault |
| 2 | `add_tranche` | Authority | Creates Tranche PDA and its share mint |
| 3 | `deposit` | User | Deposits into a specific tranche, mints tranche shares |
| 4 | `redeem` | User | Redeems tranche shares for assets |
| 5 | `distribute_yield` | Manager | Runs waterfall to allocate yield across tranches |
| 6 | `record_loss` | Manager | Triggers bottom-up loss absorption |
| 7 | `rebalance_tranches` | Manager | Adjust allocations between tranches |
| 8 | `update_tranche_config` | Authority | Modify target yield, cap, subordination |
| 9 | `pause` / `unpause` | Authority | Emergency controls |
| 10 | `transfer_authority` | Authority | Transfer admin |

### 5.1 `deposit`

User chooses which tranche to enter.

```
deposit(tranche_priority: u8, assets: u64, min_shares_out: u64):
  ✓ vault not paused, assets > 0
  ✓ Tranche exists at this priority
  ✓ After deposit, tranche does not exceed cap_bps
  ✓ After deposit, subordination ratios maintained
  → Transfer assets from user to asset_vault
  → shares = convert_to_shares(
      assets,
      tranche.total_shares,
      tranche.total_assets_allocated,
      offset
    )
  → require!(shares >= min_shares_out)
  → Mint tranche shares to user
  → tranche.total_assets_allocated += assets
  → vault.total_assets += assets
  → check_subordination(all_tranches, vault.total_assets)
  → emit TrancheDeposit { vault, tranche: priority, assets, shares }
```

### 5.2 `redeem`

```
redeem(tranche_priority: u8, shares: u64, min_assets_out: u64):
  ✓ vault not paused, user has shares
  → assets = convert_to_assets(
      shares,
      tranche.total_shares,
      tranche.total_assets_allocated,
      offset
    )
  → require!(assets >= min_assets_out)
  → After redeem, subordination ratios still maintained
     (withdrawing senior is fine; withdrawing junior may breach subordination)
  → Burn tranche shares
  → Transfer assets from asset_vault to user
  → tranche.total_assets_allocated -= assets
  → vault.total_assets -= assets
  → check_subordination(all_tranches, vault.total_assets)
  → emit TrancheRedeem { vault, tranche: priority, shares, assets }
```

### 5.3 `distribute_yield`

Manager triggers yield distribution. New yield is deposited or recognized, then waterfall runs.

```
distribute_yield(total_yield: u64):
  ✓ signer == vault.manager
  → distributions = distribute_yield_sequential(total_yield, tranches) // or ProRata
  → For each tranche:
      tranche.total_assets_allocated += distributions[i]
  → vault.total_assets += total_yield
  → emit YieldDistributed { vault, total_yield, per_tranche: distributions }
```

### 5.4 `record_loss`

Manager records a loss event (e.g., loan default). Waterfall absorbs losses bottom-up.

```
record_loss(total_loss: u64):
  ✓ signer == vault.manager
  ✓ total_loss <= vault.total_assets
  → absorb_losses(total_loss, &mut tranches)
  → vault.total_assets -= total_loss
  → emit LossRecorded { vault, total_loss, per_tranche_impact: [...] }
```

---

## 6. Per-Tranche Share Price

Each tranche has its own share price, independent of other tranches:

```
tranche_share_price = tranche.total_assets_allocated / tranche.total_shares

Senior share price: stable (gets target yield, losses absorbed by junior first)
Mezzanine share price: moderate volatility
Junior share price: highest volatility (residual yield, first loss)
```

When losses are recorded, junior share price drops. When yield is distributed, senior share price increases predictably (target yield), junior share price increases with whatever remains.

---

## 7. Subordination Invariant

The key safety property: senior tranches must always have sufficient junior capital below them.

Example with 30% subordination on senior:
- Total pool: $10M
- Senior: $7M (70%)
- Junior: $3M (30%) ✓ meets 30% subordination

If junior investors try to withdraw $1M:
- Junior would drop to $2M (22%) ✗ breaches 30% subordination
- Redeem is rejected on-chain

This prevents a "run on the junior" that would leave senior unprotected.

---

## 8. Async Variant

SVS-12 can be combined with SVS-10/SVS-11 async patterns for regulated products. In this case:
- `deposit` becomes `request_deposit` → `approve_deposit` (manager-gated)
- `redeem` becomes `request_redeem` → `approve_redeem` → `claim_redemption`
- NAV per tranche comes from the oracle
- KYC attestation required per investor

This combination is how a tokenized FIDC would work: senior cotas and subordinated cotas with regulated async subscription and the waterfall enforced on-chain.

The implementation can either:
- Compose SVS-11 + SVS-12 patterns into a single program
- Or build SVS-12 as a wrapper that internally allocates to two SVS-11 vaults (one per tranche)

The first approach is recommended for simplicity — a single program with both tranche accounting and async flow.

---

## 9. Events

```rust
#[event]
pub struct TrancheDeposit {
    pub vault: Pubkey,
    pub tranche_priority: u8,
    pub investor: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct TrancheRedeem {
    pub vault: Pubkey,
    pub tranche_priority: u8,
    pub investor: Pubkey,
    pub shares: u64,
    pub assets: u64,
}

#[event]
pub struct YieldDistributed {
    pub vault: Pubkey,
    pub total_yield: u64,
    pub senior_yield: u64,
    pub junior_yield: u64,
}

#[event]
pub struct LossRecorded {
    pub vault: Pubkey,
    pub total_loss: u64,
    pub senior_loss: u64,
    pub junior_loss: u64,
}

#[event]
pub struct SubordinationStatus {
    pub vault: Pubkey,
    pub senior_pct: u16,
    pub junior_pct: u16,
    pub subordination_met: bool,
}
```

---

## 10. Module Compatibility

**Implementation:** Build with `--features modules`. Module config PDAs passed via `remaining_accounts`.

- **svs-fees:** Per-tranche fee configuration. Senior tranche may have lower fees (lower risk). Junior/equity tranche may have performance fees only.
- **svs-caps:** Per-tranche caps (max size per tranche) AND global vault cap. Also enforced via `cap_bps` on the Tranche struct.
- **svs-locks:** Per-tranche lock duration. Junior investors typically have longer lockups than senior.
- **svs-rewards:** Compatible. Could distribute governance tokens proportionally across tranches.
- **svs-access:** Per-tranche access control. Senior tranche might be open; junior tranche might require accredited investor attestation.
- **svs-oracle:** Used for pricing in async variant.

### 10.1 Per-Tranche Module Configuration

Each tranche can have independent module configuration stored in a separate PDA:

```rust
#[account]
pub struct TrancheModuleConfig {
    pub vault: Pubkey,            // 32
    pub tranche_priority: u8,     // 1
    pub bump: u8,                 // 1

    // ── Fee configuration ──
    pub entry_fee_bps: u16,       // 2  - Fee on deposit (e.g., 0 for senior, 50 for junior)
    pub exit_fee_bps: u16,        // 2  - Fee on redemption
    pub performance_fee_bps: u16, // 2  - Fee on gains (equity only typically)
    pub management_fee_bps: u16,  // 2  - Annual fee

    // ── Cap configuration ──
    pub deposit_cap: u64,         // 8  - Max deposit for this tranche (0 = uncapped)
    pub per_user_cap: u64,        // 8  - Max per user for this tranche

    // ── Lock configuration ──
    pub lock_duration_secs: u64,  // 8  - Lockup after deposit

    // ── Access configuration ──
    pub requires_attestation: bool, // 1
    pub min_attestation_type: u8,   // 1  - Minimum AttestationType required

    pub _reserved: [u8; 32],      // 32
}
// Seeds: ["tranche_config", vault, tranche_priority]
```

### 10.2 Typical Per-Tranche Settings

| Setting | Senior (0) | Mezzanine (1) | Junior/Equity (2) |
|---------|------------|---------------|-------------------|
| **Entry Fee** | 0 bps | 25 bps | 50 bps |
| **Exit Fee** | 10 bps | 25 bps | 100 bps |
| **Performance Fee** | 0 bps | 0 bps | 2000 bps (20%) |
| **Management Fee** | 50 bps | 75 bps | 100 bps |
| **Lock Period** | 0 days | 30 days | 90 days |
| **Access** | Open | Open | Accredited only |
| **Deposit Cap** | $10M | $5M | $2M |

**Rationale:**
- Senior investors pay lower fees due to lower returns
- Junior investors have longer locks to prevent runs during stress
- Equity tranche has performance fee to align GP/LP interests
- Junior/equity may require accredited investor status (higher risk)

---

## 11. Loss Scenario Walkthrough

### 11.1 Example: $1M Loan Default

**Initial State (Three-Tranche Pool)**:
```
Total Pool: $10,000,000

┌─────────────────────────────────────────┐
│  Senior Tranche (Priority 0)            │
│  Assets: $5,000,000 (50%)               │
│  Shares: 5,000,000                      │
│  Share Price: $1.00                     │
│  subordination_bps: 3000 (30% required) │
└─────────────────────────────────────────┘
┌─────────────────────────────────────────┐
│  Mezzanine Tranche (Priority 1)         │
│  Assets: $3,000,000 (30%)               │
│  Shares: 3,000,000                      │
│  Share Price: $1.00                     │
│  subordination_bps: 2000 (20% required) │
└─────────────────────────────────────────┘
┌─────────────────────────────────────────┐
│  Junior/Equity Tranche (Priority 2)     │
│  Assets: $2,000,000 (20%)               │
│  Shares: 2,000,000                      │
│  Share Price: $1.00                     │
│  subordination_bps: 0 (no subordination)│
└─────────────────────────────────────────┘
```

### 11.2 Scenario A: $1M Default (Contained in Junior)

**Event**: Borrower defaults on $1M loan. Manager calls `record_loss(1_000_000)`.

**Sequential Loss Absorption**:
```rust
absorb_losses(1_000_000, &mut tranches);
// Junior absorbs: min(1_000_000, 2_000_000) = 1_000_000
// Remaining: 0
```

**Final State**:
```
Total Pool: $9,000,000

Senior:     $5,000,000 (55.6%) - UNCHANGED - Share price: $1.00
Mezzanine:  $3,000,000 (33.3%) - UNCHANGED - Share price: $1.00
Junior:     $1,000,000 (11.1%) - LOST 50%  - Share price: $0.50
```

**Impact**: Junior investors lost 50% of their capital. Senior and mezzanine are fully protected.

### 11.3 Scenario B: $3M Default (Wipes Junior, Hits Mezz)

**Event**: Major borrower defaults on $3M loan.

**Sequential Loss Absorption**:
```rust
absorb_losses(3_000_000, &mut tranches);
// Junior absorbs: min(3_000_000, 2_000_000) = 2_000_000 (wiped out)
// Remaining: 1_000_000
// Mezzanine absorbs: min(1_000_000, 3_000_000) = 1_000,000
// Remaining: 0
```

**Final State**:
```
Total Pool: $7,000,000

Senior:     $5,000,000 (71.4%) - UNCHANGED  - Share price: $1.00
Mezzanine:  $2,000,000 (28.6%) - LOST 33%   - Share price: $0.67
Junior:             $0 (0%)    - WIPED OUT  - Share price: $0.00
```

**Impact**: Junior is completely wiped. Mezzanine lost 1/3 of capital. Senior still protected.

### 11.4 Scenario C: $6M Default (Hits Senior)

**Event**: Catastrophic portfolio failure, $6M total losses.

**Sequential Loss Absorption**:
```rust
absorb_losses(6_000_000, &mut tranches);
// Junior absorbs: 2,000,000 (wiped)
// Remaining: 4,000,000
// Mezzanine absorbs: 3,000,000 (wiped)
// Remaining: 1,000,000
// Senior absorbs: 1,000,000
// Remaining: 0
```

**Final State**:
```
Total Pool: $4,000,000

Senior:     $4,000,000 (100%) - LOST 20%   - Share price: $0.80
Mezzanine:          $0 (0%)   - WIPED OUT  - Share price: $0.00
Junior:             $0 (0%)   - WIPED OUT  - Share price: $0.00
```

**Impact**: Even senior investors lose 20% when losses exceed subordination protection.

### 11.5 Scenario D: $11M Default (Total Loss)

**Event**: Pool loss exceeds total assets.

```rust
absorb_losses(11_000_000, &mut tranches);
// Junior absorbs: 2,000,000
// Mezzanine absorbs: 3,000,000
// Senior absorbs: 5,000,000
// Remaining: 1,000,000
// Error: VaultError::TotalLoss
```

**Result**: Transaction fails. In practice, manager would record actual loss amount ($10M) and vault would be marked for wind-down.

---

## 12. Compute Unit Estimates

| Instruction | Approximate CU | Notes |
|-------------|---------------|-------|
| `initialize` | ~35,000 | Create vault PDA + asset vault |
| `add_tranche` | ~25,000 | Create tranche PDA + shares mint |
| `deposit` | ~45,000 | Transfer + mint + subordination check |
| `redeem` | ~50,000 | Burn + transfer + subordination check |
| `distribute_yield` (Sequential) | ~30,000 + 5k/tranche | Iterates all tranches |
| `distribute_yield` (ProRata) | ~25,000 + 3k/tranche | Simpler math |
| `record_loss` | ~35,000 + 5k/tranche | Iterates all tranches |
| `rebalance_tranches` | ~40,000 | State updates across tranches |

**Note**: Subordination checks add ~5k CU per tranche. With 4 tranches and module hooks, budget 100k CU for deposit/redeem.

---

## 13. Limitations and Future Work

- **Max 4 tranches.** Practical limit from account size and instruction complexity. Most structured products use 2-3 tranches.
- **Static waterfall.** The waterfall mode is set at initialization. Dynamic waterfall changes would require a migration instruction.
- **No automated rebalancing.** If subordination ratios drift due to share price changes (yield/loss), the manager must manually rebalance or restrict withdrawals. Auto-rebalancing would require forced redemptions, which has legal implications.
- **Interest rate model.** `target_yield_bps` is a simple annual rate. More sophisticated models (floating rate tied to an index, step-up coupons) would require additional state and math.

---

## 14. FIDC / TIDIC Application

For Brazilian credit receivables funds (FIDCs):

| FIDC Concept | SVS-12 Mapping |
|-------------|---------------|
| Cota sênior | Senior tranche (priority 0) |
| Cota subordinada | Junior tranche (priority 1) |
| Subordinação mínima (CVM 175) | `subordination_bps` on senior tranche |
| Distribuição de rendimentos | `distribute_yield` with Sequential waterfall |
| Provisão para perdas | `record_loss` with bottom-up absorption |
| Administrador do fundo | `vault.manager` |
| Custodiante | `vault.authority` (or separate custodian role) |

A full FIDC product would combine SVS-11 (async + oracle + KYC) with SVS-12 (tranching) in the credit-markets repo, applying CVM 175 regulatory parameters to the configurable fields.

---

## See Also

- [SVS-1](./SVS-1.md) — Base vault (single asset, single share class)
- [SVS-10](./specs-SVS10.md) — Async request/fulfill pattern
- [SVS-11](./specs-SVS11.md) — Credit markets (KYC + oracle + async)
- [specs-modules.md](./specs-modules.md) — Module system for fees, caps, locks
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design patterns
