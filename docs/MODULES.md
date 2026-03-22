# SVS Module System

On-chain enforcement modules for tokenized vaults. Modules are Rust crates compiled into vault programs — not separate deployments. Each module exports pure functions and state structs with zero CPI overhead.

## Design

- **Crates, not programs.** Modules compile into the vault binary. No separate deployment, no CPI.
- **Opt-in composition.** Each SVS program imports only the modules it needs. A vault with no modules behaves identically to the base spec.
- **Config PDAs.** Modules store persistent configuration in dedicated PDAs derived from the vault PDA, keeping the core `Vault` struct unchanged.
- **Authority-gated.** Only the vault authority can create or update module config PDAs.
- **Feature-flagged.** Module state accounts are conditionally compiled behind the `"modules"` Cargo feature.

## Workspace Layout

```
modules/
├── svs-math/           # Shared math (mul_div, share conversion, BPS)
├── svs-fees/           # Entry/exit/management/performance fees
├── svs-caps/           # Global and per-user deposit caps
├── svs-locks/          # Time-locked shares
├── svs-access/         # Whitelist/blacklist with merkle proofs + account freeze
├── svs-oracle/         # Oracle price validation (staleness, deviation)
├── svs-rewards/        # Secondary reward token distribution (MasterChef-style)
└── svs-module-hooks/   # Shared integration hooks, seed constants, and error types
```

Dependencies:
- `svs-math` — pure Rust, no external deps
- `svs-fees` — depends on `svs-math`
- `svs-caps` — depends on `svs-math`
- `svs-access` — depends on `blake3` (merkle hashing)
- `svs-locks` — no external deps
- `svs-oracle` — no external deps
- `svs-rewards` — no external deps
- `svs-module-hooks` — depends on `anchor-lang`, `svs-fees`, `svs-caps`, `svs-locks`, `svs-access`

---

## svs-math

Shared math extracted from the duplicated `math.rs` across SVS programs. All vault programs and modules import this crate.

### Constants

| Name | Value | Description |
|------|-------|-------------|
| `BPS_DENOMINATOR` | `10_000` | 100% in basis points |
| `MAX_DECIMALS` | `9` | Maximum SPL token decimals |

### Functions

**`mul_div(value, numerator, denominator, rounding) -> Result<u64>`**

Safe `(value * numerator) / denominator` using u128 intermediate. Supports `Rounding::Floor` and `Rounding::Ceiling`.

**`convert_to_shares(assets, total_assets, total_shares, decimals_offset, rounding) -> Result<u64>`**

```
shares = assets * (total_shares + 10^offset) / (total_assets + 1)
```

The virtual offset (`10^(9 - asset_decimals)`) and virtual asset (`+1`) protect against inflation attacks. For USDC (6 decimals), the offset is 3, producing 1000 virtual shares.

**`convert_to_assets(shares, total_assets, total_shares, decimals_offset, rounding) -> Result<u64>`**

Inverse of `convert_to_shares`.

**`apply_bps_fee(amount, fee_bps) -> Result<(u64, u64)>`**

Returns `(amount_after_fee, fee_amount)` with ceiling rounding on the fee.

**`calculate_decimals_offset(asset_decimals) -> Result<u8>`**

Returns `MAX_DECIMALS - asset_decimals`.

### Rounding Strategy (Vault-Favoring)

| Operation | Rounding | Effect |
|-----------|----------|--------|
| deposit | Floor | User gets fewer shares |
| mint | Ceiling | User pays more assets |
| withdraw | Ceiling | User burns more shares |
| redeem | Floor | User gets fewer assets |

---

## svs-fees

Entry, exit, management, and performance fee enforcement.

### Fee Limits

| Fee Type | Max BPS | Max % |
|----------|---------|-------|
| Entry | 1000 | 10% |
| Exit | 1000 | 10% |
| Management | 500 | 5% |
| Performance | 3000 | 30% |

### State

```rust
// Seeds: ["fee_config", vault_pubkey]
pub struct FeeConfig {
    pub vault: Pubkey,
    pub fee_recipient: Pubkey,
    pub entry_fee_bps: u16,
    pub exit_fee_bps: u16,
    pub management_fee_bps: u16,
    pub performance_fee_bps: u16,
    pub high_water_mark: u64,        // scaled by 1e9
    pub last_fee_collection: i64,
    pub bump: u8,
}
```

### Functions

**`apply_entry_fee(shares, fee_bps) -> Result<(u64, u64)>`**
Returns `(net_shares, fee_shares)`. Fee shares are minted to `fee_recipient`.

**`apply_exit_fee(assets, fee_bps) -> Result<(u64, u64)>`**
Returns `(net_assets, fee_assets)`. Fee assets are transferred to `fee_recipient`.

**`accrue_management_fee(total_assets, fee_bps, seconds_elapsed) -> Result<u64>`**
Annualized fee pro-rated over elapsed time:
```
fee = total_assets * fee_bps * seconds / (10_000 * 31_536_000)
```

**`accrue_performance_fee(current_nav, high_water_mark, total_shares, fee_bps) -> Result<(u64, u64)>`**
Only charges when NAV exceeds the high-water mark. Both values scaled by `HWM_SCALE` (1e9). Returns `(fee_shares, new_hwm)`.

**`calculate_nav_per_share(total_assets, total_shares) -> Result<u64>`**
Returns `total_assets * 1e9 / total_shares`. Returns `1e9` for empty vaults.

### Integration

Vault `deposit` calls `apply_entry_fee` after computing shares, mints fee shares to `fee_recipient`. Vault `redeem`/`withdraw` calls `apply_exit_fee` before transferring assets. A separate `collect_fees` instruction accrues management and performance fees.

---

## svs-caps

Global and per-user deposit cap enforcement.

### State

```rust
// Seeds: ["cap_config", vault_pubkey]
pub struct CapConfig {
    pub vault: Pubkey,
    pub global_cap: u64,        // 0 = unlimited
    pub per_user_cap: u64,      // 0 = unlimited
    pub bump: u8,
}

// Seeds: ["user_deposit", vault_pubkey, user_pubkey]
pub struct UserDeposit {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub cumulative_assets: u64,
    pub bump: u8,
}
```

### Functions

**`check_global_cap(total_assets, deposit_amount, global_cap) -> Result<()>`**
Fails with `GlobalCapExceeded` if `total_assets + deposit_amount > global_cap`. Cap of 0 means unlimited.

**`check_user_cap(user_cumulative, deposit_amount, per_user_cap) -> Result<()>`**
Fails with `UserCapExceeded` if `user_cumulative + deposit_amount > per_user_cap`.

**`max_deposit_for_user(total_assets, user_cumulative, global_cap, per_user_cap) -> u64`**
Returns `min(global_remaining, user_remaining)`.

**`validate_cap_config(global_cap, per_user_cap) -> Result<()>`**
Ensures `per_user_cap <= global_cap` when both are set.

### Integration

Both `deposit` and `mint` handlers call `check_global_cap` and `check_user_cap` before executing. Checking only one path creates a bypass. `UserDeposit` PDA is created on first deposit and updated on each subsequent deposit/withdrawal.

---

## svs-locks

Time-locked shares with minimum lockup before redemption.

### Constants

| Name | Value |
|------|-------|
| `MAX_LOCK_DURATION` | 31,536,000 (1 year) |
| `NO_LOCK` | 0 |

### State

```rust
// Seeds: ["lock_config", vault_pubkey]
pub struct LockConfig {
    pub vault: Pubkey,
    pub lock_duration: i64,     // seconds
    pub bump: u8,
}

// Seeds: ["share_lock", vault_pubkey, owner_pubkey]
pub struct ShareLock {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub locked_until: i64,
    pub bump: u8,
}
```

### Functions

**`check_lockup(locked_until, current_timestamp) -> Result<()>`**
Fails with `SharesLocked` if `current_timestamp < locked_until`. A `locked_until` of 0 means no lock.

**`set_lock(current_timestamp, lock_duration) -> Result<i64>`**
Returns `current_timestamp + lock_duration`.

**`extend_lock(current_locked_until, current_timestamp, new_duration) -> Result<i64>`**
Returns `max(current_locked_until, current_timestamp + new_duration)`. Locks can only be extended, never reduced.

**`validate_lock_duration(lock_duration) -> Result<()>`**
Checks `0 <= duration <= MAX_LOCK_DURATION`.

### Integration

Vault `deposit` creates or extends the `ShareLock` PDA. Vault `redeem` and `withdraw` call `check_lockup` before executing. Updating `lock_duration` on `LockConfig` does not retroactively affect existing locks.

---

## svs-access

On-chain whitelist/blacklist enforcement with merkle proof verification and account freeze.

### Types

```rust
pub enum AccessMode {
    Open,       // Anyone can interact
    Whitelist,  // Only merkle proof holders
    Blacklist,  // Anyone except proof holders
}
```

### State

```rust
// Seeds: ["access_config", vault_pubkey]
pub struct AccessConfig {
    pub vault: Pubkey,
    pub mode: AccessMode,
    pub merkle_root: [u8; 32],
    pub bump: u8,
}

// Seeds: ["frozen", vault_pubkey, user_pubkey]
// Presence = frozen. Close PDA to unfreeze.
pub struct FrozenAccount {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub frozen_by: Pubkey,
    pub frozen_at: i64,
    pub bump: u8,
}
```

### Merkle Tree

Uses blake3 hashing with domain separation:
- Leaf: `blake3(0x00 || user_pubkey)`
- Internal: `blake3(0x01 || min(left, right) || max(left, right))` (sorted pairs)

Functions: `hash_leaf`, `hash_pair`, `verify_proof`, `compute_root`, `generate_proof`.

### Functions

**`check_access(mode, merkle_root, user, proof) -> Result<()>`**
- `Open`: always passes
- `Whitelist`: proof must verify the user is in the tree
- `Blacklist`: proof must NOT verify (user not in tree; empty root = everyone allowed)

**`check_not_frozen(is_frozen) -> Result<()>`**
Fails with `AccountFrozen` if frozen PDA exists.

**`verify_full_access(mode, root, user, proof, is_frozen) -> Result<()>`**
Combined check: freeze status first, then access mode.

### Integration

Every financial instruction (deposit, mint, withdraw, redeem) calls `verify_access` and `check_not_frozen`. Authority manages access via `update_merkle_root`, `freeze_account`, `unfreeze_account` instructions.

---

## svs-oracle

Shared oracle price interface for async vaults and external price sources.

### Constants

| Name | Value | Description |
|------|-------|-------------|
| `PRICE_SCALE` | `1_000_000_000` (1e9) | Fixed-point price precision |
| `DEFAULT_MAX_STALENESS` | `3600` | 1 hour |
| `MIN_STALENESS` | `60` | 1 minute minimum |
| `MAX_STALENESS` | `86400` | 24 hours maximum |
| `DEFAULT_MAX_DEVIATION_BPS` | `500` | 5% max price deviation |

### Functions

**`validate_oracle(price, updated_at, current_timestamp, max_staleness) -> Result<()>`**
Combined check: price must be non-zero and not stale.

**`validate_deviation(oracle_price, expected_price, max_deviation_bps) -> Result<()>`**
Fails if `|oracle - expected| * 10000 / expected > max_deviation_bps`.

**`assets_to_shares(assets, price_per_share) -> Result<u64>`**
`shares = assets * PRICE_SCALE / price_per_share` (floor).

**`shares_to_assets(shares, price_per_share) -> Result<u64>`**
`assets = shares * price_per_share / PRICE_SCALE` (floor).

### Integration

SVS-10 (async) and SVS-11 (credit) import this crate and constrain oracle accounts to match the expected layout. External oracle programs write accounts conforming to the interface.

---

## svs-rewards

Secondary reward token distribution proportional to share holdings. Uses a MasterChef-style accumulator.

### Constants

| Name | Value |
|------|-------|
| `REWARD_PRECISION` | `1e18` (u128) |
| `MAX_REWARD_TOKENS` | `5` per vault |

### State

```rust
// Seeds: ["reward_config", vault_pubkey, reward_mint_pubkey]
pub struct RewardConfig {
    pub vault: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_vault: Pubkey,
    pub reward_authority: Pubkey,
    pub accumulated_per_share: u128,    // scaled by 1e18
    pub last_update: i64,
    pub bump: u8,
}

// Seeds: ["user_reward", vault_pubkey, reward_mint_pubkey, user_pubkey]
pub struct UserReward {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_debt: u128,              // scaled by 1e18
    pub unclaimed: u64,
    pub bump: u8,
}
```

### Mechanism

```
pending = user_shares * accumulated_per_share - user_debt + unclaimed
```

`accumulated_per_share` is a global counter that increases each time rewards are funded. `user_debt` snapshots the accumulator when the user last interacted. The difference times user shares equals pending rewards.

### Functions

**`update_accumulated_per_share(current, reward_amount, total_shares) -> Result<u128>`**
`new = current + (reward_amount * 1e18 / total_shares)`.

**`calculate_pending_rewards(user_shares, acc_per_share, user_debt, unclaimed) -> Result<u64>`**
`(user_shares * acc_per_share - user_debt) / 1e18 + unclaimed`.

**`on_deposit(current_shares, deposit_shares, acc_per_share, current_debt, unclaimed) -> Result<(u128, u64)>`**
Snapshots pending rewards before updating debt for the new share balance.

**`on_withdraw(current_shares, withdraw_shares, acc_per_share, current_debt, unclaimed) -> Result<(u128, u64)>`**
Snapshots pending rewards before updating debt for the reduced share balance.

**`on_claim(user_shares, acc_per_share, current_debt, unclaimed) -> Result<(u64, u128, u64)>`**
Returns `(claim_amount, new_debt, 0)`. Fails with `NothingToClaim` if pending is zero.

### Integration

Vault exposes `fund_rewards(amount)` (reward authority deposits reward tokens), `claim_rewards` (user claims pending). `on_deposit` and `on_withdraw` are called internally during vault deposits/redeems to prevent double-counting.

---

## Vault Integration Pattern

Modules integrate with vault programs through `remaining_accounts`. This keeps module support fully optional — if a config PDA is not passed, the module check is skipped.

The hook functions live in the shared `svs-module-hooks` crate. Each vault program imports the crate as an optional dependency behind the `"modules"` Cargo feature and passes its own `program_id` for PDA derivation. Module state account structs (`#[account]`) remain in each program's `state.rs` since Anchor's `#[account]` macro requires a program-specific `declare_id!`. Seed constants are defined once in `svs-module-hooks` and re-exported by each program.

### How It Works

1. The vault instruction handler receives `remaining_accounts`
2. `svs_module_hooks` hook functions search for known PDAs by computing the expected address (using the caller's `program_id`) and matching against remaining accounts
3. If found, the config is deserialized (skip 8-byte discriminator, borsh deserialize fields) and the corresponding module function is called
4. If not found, the check is skipped entirely

```
deposit flow:
  1. check_deposit_access()    → verify whitelist/blacklist + freeze
  2. check_deposit_caps()      → enforce global + per-user caps
  3. convert_to_shares()       → compute shares for deposited assets
  4. apply_entry_fee()         → deduct fee shares, mint to fee_recipient
  5. set_share_lock()          → set/extend lock timestamp
  6. transfer + mint           → execute the deposit
```

```
withdraw/redeem flow:
  1. check_deposit_access()    → verify whitelist/blacklist + freeze
  2. check_share_lock()        → verify lock has expired
  3. convert_to_assets()       → compute assets for burned shares
  4. apply_exit_fee()          → deduct fee assets, transfer to fee_recipient
  5. burn + transfer           → execute the withdrawal
```

### Module Hook Results

```rust
pub struct DepositModuleResult {
    pub net_shares: u64,
    pub fee_shares: u64,
    pub fee_recipient: Option<Pubkey>,
}

pub struct WithdrawModuleResult {
    pub net_assets: u64,
    pub fee_assets: u64,
    pub fee_recipient: Option<Pubkey>,
}
```

### PDA Discovery

Each finder function computes the expected PDA using the caller's `program_id` and scans remaining accounts:

```rust
let (expected_pda, _) = Pubkey::find_program_address(
    &[FEE_CONFIG_SEED, vault_key.as_ref()],
    program_id,  // passed by the calling vault program
);
for account in remaining_accounts {
    if account.key() == expected_pda { /* deserialize */ }
}
```

---

## SDK Integration

The TypeScript SDK (`sdk/core/src/modules.ts`) provides PDA derivation, account types, and resolution utilities.

### PDA Derivation

```typescript
import {
  getFeeConfigAddress,
  deriveModuleAddresses,
  deriveUserModuleAddresses,
  deriveRewardModuleAddresses,
} from "./modules";

// All vault-level config PDAs at once
const configs = deriveModuleAddresses(programId, vault);
// configs.feeConfig, configs.capConfig, configs.lockConfig, configs.accessConfig

// All user-specific PDAs
const userPdas = deriveUserModuleAddresses(programId, vault, user);
// userPdas.userDeposit, userPdas.shareLock, userPdas.frozenAccount

// Reward PDAs
const rewardPdas = deriveRewardModuleAddresses(programId, vault, rewardMint, user);
// rewardPdas.rewardConfig, rewardPdas.userReward
```

### Resolving Accounts for Transactions

```typescript
import { resolveModuleAccounts, ModuleOptions } from "./modules";

const options: ModuleOptions = {
  includeFees: true,
  includeCaps: true,
  includeLocks: true,
  includeAccess: true,
  includeRewards: { rewardMint },
};

// Only returns accounts that exist on-chain
const accounts = await resolveModuleAccounts(
  connection, programId, vault, user, options
);

// Pass as remaining_accounts in the transaction
const remainingAccounts = Object.values(accounts)
  .filter(Boolean)
  .map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  }));
```

### Checking Module Status

```typescript
import { checkModuleStatus } from "./modules";

const status = await checkModuleStatus(connection, programId, vault);
// status.feeConfigExists, status.capConfigExists, etc.
```

---

## PDA Reference

| Account | Seeds | Scope |
|---------|-------|-------|
| FeeConfig | `["fee_config", vault]` | Per vault |
| CapConfig | `["cap_config", vault]` | Per vault |
| UserDeposit | `["user_deposit", vault, user]` | Per user per vault |
| LockConfig | `["lock_config", vault]` | Per vault |
| ShareLock | `["share_lock", vault, owner]` | Per user per vault |
| AccessConfig | `["access_config", vault]` | Per vault |
| FrozenAccount | `["frozen", vault, user]` | Per user per vault |
| RewardConfig | `["reward_config", vault, reward_mint]` | Per reward token per vault |
| UserReward | `["user_reward", vault, reward_mint, user]` | Per user per reward per vault |

---

## Backward Compatibility

- Vaults without modules remain identical. No breaking changes.
- Module config PDAs are optional remaining accounts. If not passed, the module check is skipped.
- Existing integrations that don't use modules continue to work without modification.

## Security Considerations

- **Fee manipulation:** `FeeConfig` is authority-gated with hard-coded upper bounds on all fee types.
- **Cap bypass:** Both `deposit` (assets to shares) and `mint` (shares to assets) must enforce caps. Checking only one creates a bypass.
- **Merkle root updates:** Changing the root on `AccessConfig` takes effect immediately. Combine with `svs-locks` or a multisig authority to mitigate.
- **Reward accumulator overflow:** `accumulated_per_share` uses u128 scaled by 1e18. With u64 shares, this supports up to ~3.4e19 reward tokens per share before overflow.
- **Lock extension only:** `extend_lock` never reduces a lock — new deposits can only extend the lockup period, preventing early withdrawal via re-deposit.
