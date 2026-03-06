# SVS Module System — Upgrade & Refactoring Spec

## Status: Draft
## Authors: Superteam Brasil
## Date: 2026-03-06

---

## 1. Motivation

The current SDK extensions (`fees.ts`, `cap.ts`, `emergency.ts`, `access-control.ts`, `multi-asset.ts`, `timelock.ts`, `strategy.ts`) are 100% client-side TypeScript. None are enforced on-chain. A malicious or custom client bypasses every protection by calling vault program instructions directly.

This spec defines the migration from client-side SDK extensions to on-chain Rust module crates that compile into vault programs and enforce invariants at the instruction level.

---

## 2. Design Principles

- **Modules are Rust crates, not Anchor programs.** They export pure functions and state structs. No separate deployment, no CPI overhead.
- **Opt-in composition.** Each SVS program imports only the modules it needs. SVS-1 with no modules remains exactly as it is today.
- **Shared math.** All modules use the existing `mul_div` from `math.rs` with vault-favoring rounding.
- **Config PDAs.** Modules that need persistent configuration store it in dedicated PDAs derived from the vault PDA. This avoids bloating the core `Vault` struct.
- **Authority-gated config.** Only the vault authority can create or update module config PDAs.

---

## 3. Module Inventory

### 3.1 `svs-fees`

**Purpose:** Entry/exit/management/performance fee enforcement on deposits and redemptions.

**Migrated from:** `sdk/core/src/fees.ts`

**State:**

```rust
#[account]
pub struct FeeConfig {
    pub vault: Pubkey,
    pub fee_recipient: Pubkey,
    pub entry_fee_bps: u16,          // applied on deposit/mint
    pub exit_fee_bps: u16,           // applied on withdraw/redeem
    pub management_fee_bps: u16,     // annualized, on total_assets
    pub performance_fee_bps: u16,    // on yield above high-water mark
    pub high_water_mark: u64,        // nav per share high-water mark
    pub last_fee_collection: i64,    // unix timestamp
    pub bump: u8,
}
// seeds: ["fee_config", vault_pda]
```

**Functions:**

```rust
pub fn apply_entry_fee(shares: u64, fee_bps: u16) -> Result<(u64, u64)>
    // Returns (shares_after_fee, fee_shares)
    // fee_shares = shares * fee_bps / 10_000 (ceiling)
    // shares_after_fee = shares - fee_shares

pub fn apply_exit_fee(assets: u64, fee_bps: u16) -> Result<(u64, u64)>
    // Returns (assets_after_fee, fee_assets)
    // fee_assets = assets * fee_bps / 10_000 (ceiling)
    // assets_after_fee = assets - fee_assets

pub fn accrue_management_fee(
    total_assets: u64,
    fee_bps: u16,
    seconds_elapsed: i64,
) -> Result<u64>
    // Returns fee_assets owed
    // fee = total_assets * fee_bps * seconds_elapsed / (10_000 * 31_536_000)

pub fn accrue_performance_fee(
    current_nav: u64,
    high_water_mark: u64,
    total_shares: u64,
    fee_bps: u16,
) -> Result<(u64, u64)>
    // Returns (fee_shares, new_high_water_mark)
    // Only charges if current_nav > high_water_mark
```

**Integration:** Vault's `deposit` handler calls `apply_entry_fee` after computing shares, mints `fee_shares` to `fee_recipient`. Vault's `redeem` handler calls `apply_exit_fee` before transferring assets. A separate `collect_fees` instruction accrues management and performance fees periodically.

---

### 3.2 `svs-caps`

**Purpose:** Global and per-user deposit cap enforcement.

**Migrated from:** `sdk/core/src/cap.ts`

**State:**

```rust
#[account]
pub struct CapConfig {
    pub vault: Pubkey,
    pub global_cap: u64,             // max total_assets (0 = unlimited)
    pub per_user_cap: u64,           // max assets per depositor (0 = unlimited)
    pub bump: u8,
}
// seeds: ["cap_config", vault_pda]

#[account]
pub struct UserDeposit {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub cumulative_assets: u64,      // total deposited (not withdrawn)
    pub bump: u8,
}
// seeds: ["user_deposit", vault_pda, user_pubkey]
```

**Functions:**

```rust
pub fn check_global_cap(
    total_assets: u64,
    deposit_amount: u64,
    global_cap: u64,
) -> Result<()>
    // Fails with CapExceeded if total_assets + deposit_amount > global_cap

pub fn check_user_cap(
    user_cumulative: u64,
    deposit_amount: u64,
    per_user_cap: u64,
) -> Result<()>
    // Fails with UserCapExceeded if user_cumulative + deposit_amount > per_user_cap

pub fn max_deposit_for_user(
    total_assets: u64,
    user_cumulative: u64,
    global_cap: u64,
    per_user_cap: u64,
) -> u64
    // Returns min(global_remaining, user_remaining)
```

**Integration:** Vault's `deposit` and `mint` handlers call `check_global_cap` and `check_user_cap` before executing. `UserDeposit` PDA is created on first deposit and updated on each subsequent deposit/withdrawal.

---

### 3.3 `svs-locks`

**Purpose:** Time-locked shares with minimum lockup before redemption.

**Migrated from:** Partial overlap with `sdk/core/src/timelock.ts` (governance timelock aspect is dropped — that belongs in a governance program, not a vault module).

**State:**

```rust
#[account]
pub struct LockConfig {
    pub vault: Pubkey,
    pub lock_duration: i64,          // seconds — minimum hold before redeem
    pub bump: u8,
}
// seeds: ["lock_config", vault_pda]

#[account]
pub struct ShareLock {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub locked_until: i64,           // unix timestamp
    pub bump: u8,
}
// seeds: ["share_lock", vault_pda, owner_pubkey]
```

**Functions:**

```rust
pub fn check_lockup(locked_until: i64, current_timestamp: i64) -> Result<()>
    // Fails with LockupNotExpired if current_timestamp < locked_until

pub fn set_lock(current_timestamp: i64, lock_duration: i64) -> Result<i64>
    // Returns locked_until = current_timestamp + lock_duration
```

**Integration:** Vault's `deposit` handler creates or updates `ShareLock` PDA with `locked_until = now + lock_duration`. Vault's `redeem` and `withdraw` handlers call `check_lockup` before executing. Authority can update `lock_duration` on `LockConfig` (does not retroactively affect existing locks).

---

### 3.4 `svs-rewards`

**Purpose:** Secondary reward token distribution to vault shareholders, proportional to share holdings.

**Migrated from:** No existing SDK extension — new module.

**State:**

```rust
#[account]
pub struct RewardConfig {
    pub vault: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_vault: Pubkey,        // PDA-owned token account holding undistributed rewards
    pub reward_authority: Pubkey,    // who can fund rewards
    pub accumulated_per_share: u128, // scaled by 1e18 for precision
    pub last_update: i64,
    pub bump: u8,
}
// seeds: ["reward_config", vault_pda, reward_mint]

#[account]
pub struct UserReward {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_debt: u128,           // accumulated_per_share snapshot at last claim
    pub unclaimed: u64,
    pub bump: u8,
}
// seeds: ["user_reward", vault_pda, reward_mint, user_pubkey]
```

**Functions:**

```rust
pub fn update_accumulated(
    total_shares: u64,
    new_rewards: u64,
    current_accumulated: u128,
) -> Result<u128>
    // new_accumulated = current + (new_rewards * 1e18 / total_shares)

pub fn pending_rewards(
    user_shares: u64,
    accumulated_per_share: u128,
    user_reward_debt: u128,
) -> Result<u64>
    // rewards = user_shares * (accumulated - debt) / 1e18
```

**Integration:** Vault exposes `fund_rewards(amount)` (reward_authority deposits reward tokens), `claim_rewards` (user claims pending), and `update_reward_debt` (called internally on deposit/redeem to prevent double-counting).

---

### 3.5 `svs-access`

**Purpose:** On-chain whitelist/blacklist enforcement with merkle proof verification and account freeze.

**Migrated from:** `sdk/core/src/access-control.ts`

**State:**

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum AccessMode {
    Open,
    Whitelist,
    Blacklist,
}

#[account]
pub struct AccessConfig {
    pub vault: Pubkey,
    pub mode: AccessMode,
    pub merkle_root: [u8; 32],      // keccak256 root (zero if using direct list)
    pub bump: u8,
}
// seeds: ["access_config", vault_pda]

#[account]
pub struct FrozenAccount {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub frozen_by: Pubkey,
    pub frozen_at: i64,
    pub bump: u8,
}
// seeds: ["frozen", vault_pda, user_pubkey]
// Presence = frozen. Close PDA to unfreeze.
```

**Functions:**

```rust
pub fn verify_access(
    mode: &AccessMode,
    merkle_root: &[u8; 32],
    user: &Pubkey,
    proof: &[[u8; 32]],
) -> Result<()>
    // Open: always passes
    // Whitelist: verify_merkle_proof(root, leaf=hash(user), proof) must be true
    // Blacklist: verify_merkle_proof must be false (user NOT in tree)

pub fn check_not_frozen(frozen_account_info: &AccountInfo) -> Result<()>
    // Fails with AccountFrozen if account exists and is initialized
```

**Integration:** Every financial instruction (deposit, mint, withdraw, redeem) calls `verify_access` and `check_not_frozen`. Authority manages access via `update_merkle_root`, `freeze_account`, `unfreeze_account` instructions.

---

### 3.6 `svs-oracle`

**Purpose:** Shared oracle price interface struct for async vaults and any external price source.

**Not migrated from SDK** — new shared interface.

**State:**

```rust
/// Any oracle account passed to async vault instructions must
/// deserialize to this layout. The vault reads price_per_share
/// and validates staleness.
#[account]
pub struct OraclePrice {
    pub price_per_share: u64,        // fixed-point, decimals match share mint
    pub updated_at: i64,             // unix timestamp of last update
    pub authority: Pubkey,           // who posted this price
    pub bump: u8,
}
```

**Functions:**

```rust
pub fn validate_oracle(
    oracle: &OraclePrice,
    max_staleness: i64,
    current_timestamp: i64,
) -> Result<()>
    // Fails if price_per_share == 0
    // Fails if current_timestamp - updated_at > max_staleness
```

**Integration:** SVS-10 (async) and SVS-11 (credit) import this crate and constrain oracle accounts to match the `OraclePrice` layout. External oracle programs (like `credit_markets_nav_oracle`) write accounts conforming to this struct.

---

## 4. Workspace Layout

```
modules/
├── svs-fees/
│   ├── Cargo.toml
│   └── src/lib.rs
├── svs-caps/
│   ├── Cargo.toml
│   └── src/lib.rs
├── svs-locks/
│   ├── Cargo.toml
│   └── src/lib.rs
├── svs-rewards/
│   ├── Cargo.toml
│   └── src/lib.rs
├── svs-access/
│   ├── Cargo.toml
│   └── src/lib.rs
└── svs-oracle/
    ├── Cargo.toml
    └── src/lib.rs
```

Each module's `Cargo.toml` depends on `anchor-lang` for serialization and the shared `svs-math` crate (extracted from SVS-1's `math.rs`).

---

## 5. Shared Math Extraction

The current `math.rs` is duplicated across SVS-1 through SVS-4. Extract into a shared crate:

```
modules/
└── svs-math/
    ├── Cargo.toml
    └── src/lib.rs     // mul_div, convert_to_shares, convert_to_assets, Rounding enum
```

All SVS programs and all modules import `svs-math` instead of maintaining their own copy.

---

## 6. Migration Plan

### Phase 1: Extract shared crates
- Create `svs-math` from existing `math.rs`
- Create `svs-oracle` interface
- Update SVS-1 through SVS-4 to import `svs-math` instead of local `math.rs`
- Verify all 256 existing program tests still pass

### Phase 2: Implement enforcement modules
- Build `svs-fees`, `svs-caps`, `svs-locks`, `svs-access` as Rust crates
- Port math from TypeScript extensions, verify parity with property tests
- Each module gets its own unit test suite

### Phase 3: Integrate modules into vault programs
- Add optional module integration to SVS-1/SVS-2 as reference implementations
- Add new instructions: `initialize_fee_config`, `update_caps`, `freeze_account`, etc.
- Existing instructions gain module checks (deposit calls `check_caps`, `verify_access`, `apply_entry_fee`)

### Phase 4: SDK becomes thin client
- Deprecate `sdk/core/src/fees.ts`, `cap.ts`, `emergency.ts`, `access-control.ts`, `timelock.ts`, `strategy.ts`
- SDK builds transactions that pass module config PDAs to on-chain instructions
- SDK retains preview functions (simulate on-chain math client-side for UX)

### Phase 5: CLI alignment
- CLI commands call SDK which calls on-chain module-enabled instructions
- Remove any CLI logic that enforced caps or fees client-side

---

## 7. Backward Compatibility

- SVS-1 through SVS-4 without modules remain identical. No breaking changes.
- Module config PDAs are optional accounts. If not passed to an instruction, the module check is skipped. This means existing integrations that don't use modules continue to work.
- SDK v1 (current extensions) continues to function but is marked deprecated. SDK v2 targets on-chain modules.

---

## 8. Security Considerations

- **Fee manipulation:** `FeeConfig` is authority-gated. Fee BPS values should have sane upper bounds (e.g., entry/exit ≤ 1000 bps = 10%, management ≤ 500 bps = 5%).
- **Merkle root updates:** Changing the merkle root on `AccessConfig` takes effect immediately. A malicious authority could whitelist themselves and drain. Mitigation: combine with `svs-locks` timelock on config changes, or use a multisig authority.
- **Reward accumulator precision:** The `accumulated_per_share` uses u128 scaled by 1e18. With u64 shares, this supports up to ~3.4e19 reward tokens per share before overflow — sufficient for any realistic scenario.
- **Cap bypass via mint:** Both `deposit` (assets→shares) and `mint` (shares→assets) must enforce caps. Checking only one creates a bypass.

---

## 9. Integration Examples

### Adding svs-fees to SVS-1

```rust
// Cargo.toml
[dependencies]
svs-fees = { path = "../modules/svs-fees" }

// In deposit handler
pub fn handler(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
    // ... existing validation ...

    // Calculate shares
    let gross_shares = convert_to_shares(...)?;

    // Apply entry fee if FeeConfig exists
    let (net_shares, fee_shares) = if let Some(fee_config) = &ctx.accounts.fee_config {
        svs_fees::apply_entry_fee(gross_shares, fee_config.entry_fee_bps)?
    } else {
        (gross_shares, 0)
    };

    require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);

    // Mint net shares to user
    mint_to(user_shares_account, net_shares)?;

    // Mint fee shares to fee recipient
    if fee_shares > 0 {
        mint_to(fee_config.fee_recipient, fee_shares)?;
    }

    // ... rest of handler ...
}
```

### Adding svs-caps to SVS-1

```rust
// In deposit handler
pub fn handler(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
    // Check caps BEFORE executing
    if let Some(cap_config) = &ctx.accounts.cap_config {
        svs_caps::check_global_cap(
            ctx.accounts.asset_vault.amount,
            assets,
            cap_config.global_cap,
        )?;

        if let Some(user_deposit) = &ctx.accounts.user_deposit {
            svs_caps::check_user_cap(
                user_deposit.cumulative_assets,
                assets,
                cap_config.per_user_cap,
            )?;
        }
    }

    // ... execute deposit ...

    // Update user cumulative after deposit
    if let Some(user_deposit) = &mut ctx.accounts.user_deposit {
        user_deposit.cumulative_assets = user_deposit.cumulative_assets
            .checked_add(assets)
            .ok_or(VaultError::MathOverflow)?;
    }
}
```

---

## 10. Module Interaction Matrix

| Modules | Compatible | Notes |
|---------|------------|-------|
| fees + caps | ✅ | Fees applied after cap check |
| fees + locks | ✅ | Independent operation |
| caps + locks | ✅ | Independent operation |
| fees + access | ✅ | Access checked before fees |
| rewards + any | ✅ | Rewards are independent |
| access + freeze | ✅ | Freeze is part of access |

---

## 11. SDK v1 → v2 Migration Guide

### v1 (Client-Side Extensions)

```typescript
// Current: Extensions are TypeScript wrappers
import { SolanaVault, FeeExtension, CapExtension } from '@stbr/solana-vault';

const vault = await SolanaVault.load(connection, vaultPda);
const feeExtension = new FeeExtension(vault, feeConfig);
const capExtension = new CapExtension(vault, capConfig);

// Client calculates fees/caps locally
const netShares = feeExtension.calculateNetShares(assets);
const canDeposit = capExtension.checkCap(assets);
```

### v2 (On-Chain Modules)

```typescript
// Future: Modules enforced on-chain
import { SolanaVault } from '@stbr/solana-vault';

const vault = await SolanaVault.load(connection, vaultPda);

// Fees and caps enforced by program
// SDK just builds transaction with correct accounts
const tx = await vault.deposit(assets, minSharesOut, {
  feeConfig: feeConfigPda,        // Optional module PDAs
  userDeposit: userDepositPda,
});
```

### Migration Steps

1. **Deploy module-enabled vault program**
2. **Create module config PDAs** (`initialize_fee_config`, etc.)
3. **Update SDK to v2** (pass module PDAs to transactions)
4. **Remove client-side extension logic** (deprecated)
5. **Update tests** to use on-chain enforcement

---

## 12. Per-Module Test Requirements

| Module | Required Tests |
|--------|----------------|
| svs-fees | Entry fee calculation, exit fee calculation, management fee accrual, performance fee (high-water mark) |
| svs-caps | Global cap enforcement, per-user cap enforcement, cap bypass via mint check |
| svs-locks | Lock creation, lock update on deposit, lockup check on redeem, retroactive exemption |
| svs-access | Open mode, whitelist mode, blacklist mode, merkle proof verification, freeze/unfreeze |
| svs-rewards | Reward funding, reward claim, reward debt update, precision overflow check |

---

**See Also**:
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Module integration points
- [PATTERNS.md](./PATTERNS.md) — Implementation patterns
- [ERRORS.md](./ERRORS.md) — Module error codes
