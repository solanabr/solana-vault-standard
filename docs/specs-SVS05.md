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

**Implementation:** Build with `--features modules` to enable. Module config PDAs passed via `remaining_accounts`.

SVS-5 supports all modules defined in `specs-modules.md`:

- **svs-fees:** Applied on deposit/redeem after share computation. Management fees accrue on `effective_total_assets(now)`.
- **svs-caps:** Checked against `effective_total_assets(now)` + deposit amount.
- **svs-locks:** ShareLock created on deposit, checked on redeem. Works identically.
- **svs-rewards:** Secondary rewards independent of streaming yield. Both can run simultaneously.
- **svs-access:** Whitelist/blacklist/freeze checks on every financial instruction.

---

## 10. Compute Budget

`effective_total_assets` adds one `mul_div` call (u128 intermediate) per instruction compared to SVS-1's direct balance read or SVS-2's stored value. Estimated overhead: ~200 CU. Well within Solana's 200k default budget.

---

## 11. Yield Distribution Walkthrough

### Scenario: 2-Week Streaming Period

**Setup**:
- Stream duration: 14 days (1,209,600 seconds)
- Yield to distribute: 10,000 USDC
- Two depositors: Alice (1000 shares), Bob (500 shares)
- Initial base_assets: 15,000 USDC
- Initial share price: 10 USDC/share

**Timeline**:

1. **Day 0**: Authority calls `distribute_yield(10_000_000_000, 1_209_600)`
   - `yield_per_second = 10,000 / 1,209,600 ≈ 0.00827 USDC/sec`
   - `stream_start = current_timestamp`
   - `stream_end = current_timestamp + 1,209,600`
   - `stream_amount = 10,000 USDC`

2. **Day 3**: Alice queries share price
   - Elapsed: 259,200 seconds
   - Accrued yield: `10,000 × (259,200 / 1,209,600) ≈ 2,143 USDC`
   - `effective_total_assets = 15,000 + 2,143 = 17,143 USDC`
   - Share price: `17,143 / 1,500 = 11.43 USDC/share`
   - Alice's position value: `1,000 × 11.43 = 11,429 USDC` (up from 10,000)

3. **Day 7**: Bob deposits 5,000 USDC
   - Accrued yield: `10,000 × (604,800 / 1,209,600) = 5,000 USDC`
   - `effective_total_assets = 15,000 + 5,000 = 20,000 USDC`
   - Share price: `20,000 / 1,500 = 13.33 USDC/share`
   - Bob receives: `5,000 / 13.33 ≈ 375 shares`
   - New total_shares: 1,875
   - Remaining yield (5,000 USDC) now distributes across 1,875 shares

4. **Day 14**: Stream ends, anyone calls `checkpoint()`
   - All 10,000 USDC distributed
   - Final `base_assets = 25,000 USDC` (15,000 + 10,000)
   - Final share price: `25,000 / 1,875 = 13.33 USDC/share`
   - Alice's position: `1,000 × 13.33 = 13,333 USDC` (33% gain)
   - Bob's position: `375 × 13.33 = 5,000 USDC` (0% gain, joined at peak)

**Key Observation**: Early depositors benefit more from streaming yield. Late depositors buy at higher share price.

---

## 12. distribute_yield Account Context

```rust
#[derive(Accounts)]
pub struct DistributeYield<'info> {
    #[account(
        mut,
        seeds = [b"stream_vault", vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority,
        has_one = asset_vault,
    )]
    pub vault: Account<'info, StreamVault>,

    #[account(mut)]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    /// Source of yield tokens (could be authority's ATA or external protocol)
    #[account(
        mut,
        token::mint = vault.asset_mint,
    )]
    pub yield_source: InterfaceAccount<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn distribute_yield(
    ctx: Context<DistributeYield>,
    yield_amount: u64,
    duration: i64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // 1. Validate inputs
    require!(yield_amount > 0, VaultError::ZeroAmount);
    require!(duration >= 60, VaultError::StreamTooShort); // Minimum 60 seconds

    // 2. If stream is active, checkpoint first
    if now < vault.stream_end && vault.stream_amount > 0 {
        // Auto-checkpoint to finalize current stream
        let accrued = effective_total_assets(vault, now)?
            .checked_sub(vault.base_assets)
            .ok_or(VaultError::MathOverflow)?;

        vault.base_assets = vault.base_assets.checked_add(accrued)?;
        vault.stream_amount = 0;
    }

    // 3. Transfer yield tokens from source to vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.yield_source.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.vault.asset_mint.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        yield_amount,
        ctx.accounts.asset_vault.decimals,
    )?;

    // 4. Initialize new stream
    vault.stream_amount = yield_amount;
    vault.stream_start = now;
    vault.stream_end = now.checked_add(duration).ok_or(VaultError::MathOverflow)?;
    vault.last_checkpoint = now;

    emit!(YieldStreamStarted {
        vault: vault.key(),
        amount: yield_amount,
        duration,
        start: now,
        end: vault.stream_end,
    });

    Ok(())
}
```

---

## 13. checkpoint() Implementation Detail

```rust
#[derive(Accounts)]
pub struct Checkpoint<'info> {
    #[account(
        mut,
        seeds = [b"stream_vault", vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, StreamVault>,
    // Note: Permissionless - no signer required
}

pub fn checkpoint(ctx: Context<Checkpoint>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // 1. Calculate accrued yield since last checkpoint
    let effective = effective_total_assets(vault, now)?;
    let accrued = effective
        .checked_sub(vault.base_assets)
        .ok_or(VaultError::MathOverflow)?;

    // 2. Early exit if nothing to accrue
    if accrued == 0 {
        return Ok(());
    }

    // 3. Update state
    vault.base_assets = effective;

    if now >= vault.stream_end {
        // Stream complete - clear stream state
        vault.stream_amount = 0;
        vault.stream_start = now;
        vault.stream_end = now;
    } else {
        // Partial checkpoint - reduce remaining stream
        vault.stream_amount = vault.stream_amount
            .checked_sub(accrued)
            .ok_or(VaultError::MathOverflow)?;
        vault.stream_start = now;
    }

    vault.last_checkpoint = now;

    emit!(Checkpoint {
        vault: vault.key(),
        accrued,
        new_base_assets: vault.base_assets,
        timestamp: now,
    });

    Ok(())
}
```

### State Transitions

```
┌─────────────────────────────────────────────────────────────────┐
│                         IDLE STATE                              │
│  stream_amount = 0, stream_end <= now                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ distribute_yield(amount, duration)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      STREAMING STATE                            │
│  stream_amount > 0, stream_start < now < stream_end            │
│  effective_total_assets = base_assets + accrued(now)           │
└─────────────────────────────────────────────────────────────────┘
        │                     │                           │
        │ checkpoint()        │ now >= stream_end         │ distribute_yield()
        │ (partial)           │                           │ (auto-checkpoints)
        ▼                     ▼                           ▼
┌───────────────┐   ┌─────────────────┐   ┌─────────────────────────┐
│ STREAMING     │   │ IDLE STATE      │   │ NEW STREAMING STATE     │
│ (updated)     │   │ (stream done)   │   │ (previous finalized)    │
└───────────────┘   └─────────────────┘   └─────────────────────────┘
```

---

## 14. Compute Unit Estimates

| Instruction | Approximate CU | Notes |
|-------------|---------------|-------|
| `initialize` | ~25,000 | Create vault + shares mint + asset vault |
| `deposit` | ~30,000 | Includes effective_total_assets computation |
| `withdraw` | ~35,000 | Includes effective_total_assets computation |
| `distribute_yield` | ~20,000 | May include auto-checkpoint (+8k) |
| `checkpoint` | ~8,000 | Simple state update |
| `effective_total_assets` | ~200 | Added overhead per instruction |

---

## See Also

- [SVS-1](./SVS-1.md) — Base live balance model
- [SVS-2](./SVS-2.md) — Stored balance with sync
- [SVS-6](./specs-SVS06.md) — Streaming + Confidential variant
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design
- [specs-modules.md](./specs-modules.md) — Module integration
