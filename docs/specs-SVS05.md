# SVS-5: Streaming Yield Vault

## Status: Draft
## Authors: Superteam Brasil
## Date: 2026-03-06
## Base: ERC-4626 + Sablier-style continuous yield

---

## 1. Overview

SVS-5 extends the ERC-4626 vault model with time-interpolated yield distribution. Instead of yield appearing as a discrete jump (SVS-2's `sync()`), total assets increase linearly between distribution checkpoints. Share price appreciates smoothly over time rather than in steps.

This vault type is suited for payroll vaults, vesting schedules, DCA strategies, and any product where predictable, continuous yield recognition improves UX or accounting.

---

## 2. How It Differs from SVS-1/SVS-2

| Aspect | SVS-1 (Live) | SVS-2 (Sync) | SVS-5 (Streaming) |
|--------|-------------|-------------|-------------------|
| `total_assets` source | `asset_vault.amount` (real-time) | `vault.total_assets` (cached) | Interpolated between checkpoints |
| Yield recognition | Instant (any token transfer) | Discrete (authority calls `sync`) | Continuous (linear over time) |
| Share price updates | Every block | Only on sync | Every instruction (computed) |
| Authority control | None | Full (controls when sync happens) | Partial (sets rate, flow is automatic) |

The core difference: `total_assets()` is not a stored value or a live read. It's a **computed value** based on the current timestamp:

```
effective_total_assets = base_assets + accrued_yield(now)

accrued_yield(now) = yield_rate * min(now - stream_start, stream_duration) / stream_duration
```

---

## 3. State

```rust
#[account]
pub struct StreamVault {
    // ── Core vault fields (same as SVS-1) ──
    pub authority: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,

    // ── Streaming fields ──
    pub base_assets: u64,            // total_assets at last checkpoint
    pub total_shares: u64,           // current shares outstanding
    pub stream_amount: u64,          // yield to distribute over current stream
    pub stream_start: i64,           // unix timestamp — stream begin
    pub stream_end: i64,             // unix timestamp — stream end
    pub last_checkpoint: i64,        // when base_assets was last updated

    pub _reserved: [u8; 64],
}
// seeds: ["stream_vault", asset_mint, vault_id.to_le_bytes()]
```

---

## 4. Core Math

```rust
/// Compute effective total_assets at a given timestamp.
/// This replaces direct reads of vault.total_assets or asset_vault.amount.
pub fn effective_total_assets(vault: &StreamVault, now: i64) -> Result<u64> {
    if now >= vault.stream_end || vault.stream_start >= vault.stream_end {
        // Stream complete or no active stream
        return vault.base_assets.checked_add(vault.stream_amount)
            .ok_or(error!(VaultError::MathOverflow));
    }
    if now <= vault.stream_start {
        return Ok(vault.base_assets);
    }

    let elapsed = (now - vault.stream_start) as u64;
    let duration = (vault.stream_end - vault.stream_start) as u64;
    let accrued = mul_div(vault.stream_amount, elapsed, duration, Rounding::Floor)?;

    vault.base_assets.checked_add(accrued)
        .ok_or(error!(VaultError::MathOverflow))
}

/// Share conversions use effective_total_assets instead of stored/live balance
pub fn convert_to_shares(assets: u64, total_shares: u64, total_assets: u64, offset: u64) -> Result<u64> {
    // Same formula as SVS-1, but total_assets = effective_total_assets(now)
    mul_div(assets, total_shares + offset, total_assets + 1, Rounding::Floor)
}
```

---

## 5. Instruction Set

| # | Instruction | Signer | Description |
|---|------------|--------|-------------|
| 1 | `initialize` | Authority | Creates StreamVault PDA, share mint, asset vault |
| 2 | `deposit` | User | Deposits assets, mints shares at current effective_total_assets |
| 3 | `mint` | User | Mints exact shares, pays assets at current effective_total_assets |
| 4 | `withdraw` | User | Withdraws exact assets, burns shares at current effective_total_assets |
| 5 | `redeem` | User | Redeems shares for assets at current effective_total_assets |
| 6 | `distribute_yield` | Authority | Starts a new yield stream over a specified duration |
| 7 | `checkpoint` | Permissionless | Finalizes accrued yield into base_assets, resets stream state |
| 8 | `pause` | Authority | Emergency pause |
| 9 | `unpause` | Authority | Resume operations |
| 10 | `transfer_authority` | Authority | Transfer vault admin |

### 5.1 `distribute_yield`

The key new instruction. Authority deposits yield tokens and specifies a distribution period.

```
distribute_yield(yield_amount: u64, duration: i64):
  ✓ signer == vault.authority
  ✓ yield_amount > 0
  ✓ duration > 0
  ✓ No active stream (stream_end <= now) — or checkpoint first
  → Transfer yield_amount from authority to asset_vault
  → vault.stream_amount = yield_amount
  → vault.stream_start = clock.unix_timestamp
  → vault.stream_end = clock.unix_timestamp + duration
  → emit YieldStreamStarted { vault, amount, duration, start, end }
```

### 5.2 `checkpoint`

Permissionless crank that finalizes accrued yield. Can be called by anyone (MEV bots, keepers, users).

```
checkpoint():
  → accrued = effective_total_assets(now) - vault.base_assets
  → vault.base_assets += accrued
  → vault.stream_amount -= accrued (or 0 if stream complete)
  → vault.stream_start = now
  → vault.last_checkpoint = now
  → emit Checkpoint { vault, accrued, new_base_assets }
```

---

## 6. Deposit / Redeem Behavior

All deposit/redeem operations use `effective_total_assets(clock.unix_timestamp)` for share price computation. This means:

- Two users depositing at different times during a stream get different share prices.
- Share price monotonically increases during a stream (assuming no withdrawals exceed yield).
- No MEV opportunity from front-running a `sync()` call (unlike SVS-2).

**Rounding:** Same as SVS-1 — floor on deposit (fewer shares), ceiling on withdraw (burn more shares), floor on redeem (fewer assets), ceiling on mint (pay more assets). Always favors the vault.

---

## 7. Edge Cases

**Empty stream (stream_amount = 0):** Vault behaves identically to SVS-1 with `total_assets = base_assets`.

**Stream already active when `distribute_yield` called:** Must `checkpoint` first to finalize the current stream. Alternatively, the instruction can auto-checkpoint and start a new stream in the same tx.

**All shares redeemed mid-stream:** Remaining stream_amount stays in the asset_vault. Next depositor inherits the unrealized yield at the then-current rate. This is vault-favoring behavior — same as SVS-1's virtual offset protecting against share price manipulation.

**Clock manipulation:** Solana's `Clock::unix_timestamp` is validator-reported and can drift ±1-2 seconds. For streams measured in hours/days, this is negligible. For very short streams (seconds), accuracy degrades. Minimum stream duration should be enforced (e.g., 60 seconds).

---

## 8. Events

```rust
#[event]
pub struct YieldStreamStarted {
    pub vault: Pubkey,
    pub amount: u64,
    pub duration: i64,
    pub start: i64,
    pub end: i64,
}

#[event]
pub struct Checkpoint {
    pub vault: Pubkey,
    pub accrued: u64,
    pub new_base_assets: u64,
    pub timestamp: i64,
}

// Deposit, Withdraw, VaultInitialized, VaultStatusChanged, AuthorityTransferred
// reused from SVS-1 event definitions.
```

---

## 9. Module Compatibility

SVS-5 supports all modules defined in `specs-modules.md`:

- **svs-fees:** Applied on deposit/redeem after share computation. Management fees accrue on `effective_total_assets(now)`.
- **svs-caps:** Checked against `effective_total_assets(now)` + deposit amount.
- **svs-locks:** ShareLock created on deposit, checked on redeem. Works identically.
- **svs-rewards:** Secondary rewards independent of streaming yield. Both can run simultaneously.
- **svs-access:** Whitelist/blacklist/freeze checks on every financial instruction.

---

## 10. Compute Budget

`effective_total_assets` adds one `mul_div` call (u128 intermediate) per instruction compared to SVS-1's direct balance read or SVS-2's stored value. Estimated overhead: ~200 CU. Well within Solana's 200k default budget.
