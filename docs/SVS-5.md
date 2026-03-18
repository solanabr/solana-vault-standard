# SVS-5: Streaming Yield Vault

## Overview

SVS-5 extends SVS-2 with a time-interpolated yield distribution model where `total_assets` is computed continuously rather than stored statically or read live. Instead of yield appearing as a discrete jump when `sync()` is called, total assets increase linearly between distribution events. Share price appreciates smoothly during each stream period, eliminating the front-running window present in SVS-2.

This vault type is suited for payroll vaults, vesting schedules, DCA strategies, and any product where predictable, smooth yield recognition improves user experience or simplifies accounting.

## Balance Model

| Aspect | SVS-1 (Live) | SVS-2 (Stored) | SVS-5 (Streaming) |
|--------|-------------|----------------|-------------------|
| **total_assets source** | `asset_vault.amount` (live read) | `vault.total_assets` (cached) | `effective_total_assets(now)` (computed) |
| **Update mechanism** | Automatic (token program updates) | Manual `sync()` + deposit/withdraw arithmetic | Time-interpolated + `checkpoint()` + deposit/withdraw arithmetic |
| **Yield distribution** | Instant (any token transfer) | Discrete (authority calls `sync()`) | Continuous (linear over stream period) |
| **MEV risk** | None | Front-run `sync()` window | None (price moves smoothly) |
| **Trust model** | Trustless | Authority controls yield timing | Authority controls rate; flow is automatic |
| **Use case** | Simple vaults | Strategy vaults, deployed capital | Payroll, vesting, DCA, streaming rewards |

**Key difference**: SVS-5 replaces both the live token account read (SVS-1) and the cached field read (SVS-2) with a computed value derived from the current timestamp and stream parameters:

```
effective_total_assets(now) = base_assets + accrued_stream_yield(now)

accrued_stream_yield(now) = stream_amount * elapsed / duration   (floor)

where elapsed = min(now - stream_start, duration)
```

## Stream Mechanics

### Purpose

The streaming model distributes a fixed yield amount linearly over a configurable duration. Two instructions manage the stream lifecycle:

- `distribute_yield` — authority deposits tokens and sets the stream rate
- `checkpoint` — permissionless; materializes accrued yield into `base_assets`

### effective_total_assets

Every instruction that depends on share price calls `effective_total_assets` instead of reading a stored or live value:

```rust
// Pseudocode
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
```

### distribute_yield

Authority-only instruction. Transfers yield tokens from a source account into `asset_vault` and starts a new stream. If a stream is already active, `distribute_yield` auto-checkpoints the existing stream before starting the new one — no yield is lost.

```
distribute_yield(yield_amount: u64, duration: i64):
  1. Require signer == vault.authority
  2. Require yield_amount > 0
  3. Require duration >= 60 (minimum stream length)
  4. If active stream: auto-checkpoint (materialize accrued into base_assets)
  5. Transfer yield_amount from yield_source to asset_vault
  6. Set stream_amount = yield_amount
  7. Set stream_start = clock.unix_timestamp
  8. Set stream_end   = clock.unix_timestamp + duration
  9. Emit YieldStreamStarted { vault, amount, duration, start, end }
```

### checkpoint

Permissionless instruction callable by anyone (users, keeper bots, MEV searchers). Materializes accrued yield into `base_assets` and resets the stream start to `now`, reducing `stream_amount` by the amount already accrued.

```
checkpoint():
  1. Compute accrued = effective_total_assets(now) - base_assets
  2. If accrued == 0: no-op, return early
  3. base_assets += accrued
  4. If stream complete: stream_amount = 0, stream_start = stream_end = now
  5. Else: stream_amount -= accrued, stream_start = now
  6. last_checkpoint = now
  7. Emit Checkpoint { vault, accrued, new_base_assets, timestamp }
```

### Deposit/Withdraw Arithmetic

Deposits and withdrawals update `base_assets` directly, the same way SVS-2 updates `total_assets`:

```rust
// deposit: received assets enter the base
vault.base_assets = vault.base_assets.checked_add(assets_in)?;

// withdraw: paid assets leave the base
vault.base_assets = vault.base_assets.checked_sub(assets_out)?;
```

The streaming yield in `stream_amount` is untouched by deposit and withdraw operations. Existing stream-holders' proportional claims are maintained because share conversions use `effective_total_assets(now)` which already includes the accrued portion.

## Account Structure

### PDAs

| Account | Seeds | Purpose |
|---------|-------|---------|
| **StreamVault** | `["stream_vault", asset_mint, vault_id.to_le_bytes()]` | Vault state |
| **Shares Mint** | `["shares", vault_pubkey]` | Token-2022 mint for shares |
| **Asset Vault** | ATA of (asset_mint, StreamVault PDA) | Holds locked assets + unstreamed yield |

### State: `StreamVault` Account (251 bytes)

```rust
#[account]
pub struct StreamVault {
    pub authority: Pubkey,        // 32 bytes
    pub asset_mint: Pubkey,       // 32 bytes
    pub shares_mint: Pubkey,      // 32 bytes
    pub asset_vault: Pubkey,      // 32 bytes
    pub base_assets: u64,         // 8 bytes  — assets at last checkpoint
    pub stream_amount: u64,       // 8 bytes  — total yield in current stream
    pub stream_start: i64,        // 8 bytes  — unix timestamp: stream begin
    pub stream_end: i64,          // 8 bytes  — unix timestamp: stream end
    pub last_checkpoint: i64,     // 8 bytes  — unix timestamp: last checkpoint
    pub decimals_offset: u8,      // 1 byte
    pub bump: u8,                 // 1 byte
    pub paused: bool,             // 1 byte
    pub vault_id: u64,            // 8 bytes
    pub _reserved: [u8; 64],      // 64 bytes
}
// Seeds: ["stream_vault", asset_mint, vault_id.to_le_bytes()]
// Total: 251 bytes
```

**Key differences from SVS-2**: `total_assets` is replaced by five streaming fields — `base_assets`, `stream_amount`, `stream_start`, `stream_end`, and `last_checkpoint`. Total: 251 bytes (including 8-byte Anchor discriminator).

## Instructions

| Instruction | Accounts | Args | Access Control | Notes |
|-------------|----------|------|----------------|-------|
| **initialize** | authority, vault, asset_mint, shares_mint, asset_vault, asset_token_program, token_2022_program, associated_token_program, system_program, rent | vault_id, name, symbol | Anyone | Creates vault with base_assets = 0, stream_amount = 0 |
| **deposit** | user, vault, asset_mint, user_asset_account, asset_vault, shares_mint, user_shares_account, asset_token_program, token_2022_program | assets, min_shares_out | Anyone (when not paused) | Auto-checkpoints, mints shares at base_assets, increments base_assets |
| **mint** | user, vault, asset_mint, user_asset_account, asset_vault, shares_mint, user_shares_account, asset_token_program, token_2022_program | shares, max_assets_in | Anyone (when not paused) | Auto-checkpoints, mints exact shares, transfers required assets, increments base_assets |
| **withdraw** | user, vault, asset_mint, user_asset_account, asset_vault, shares_mint, user_shares_account, asset_token_program, token_2022_program | assets, max_shares_in | Token account owner | Auto-checkpoints, burns shares at base_assets, decrements base_assets |
| **redeem** | user, vault, asset_mint, user_asset_account, asset_vault, shares_mint, user_shares_account, asset_token_program, token_2022_program | shares, min_assets_out | Token account owner | Auto-checkpoints, burns exact shares at base_assets, decrements base_assets |
| **distribute_yield** | authority, vault, asset_mint, authority_asset_account, asset_vault, asset_token_program | yield_amount, duration | **Authority only** | Transfers tokens, starts new stream; auto-checkpoints active stream |
| **checkpoint** | vault | - | **Permissionless** | Materializes accrued yield into base_assets |
| **pause** | vault, authority | - | Authority only | Sets paused = true |
| **unpause** | vault, authority | - | Authority only | Sets paused = false |
| **transfer_authority** | vault, authority, new_authority | - | Authority only | Transfers vault admin rights |

### View Instructions (Read-only)

All view functions call `effective_total_assets(clock.unix_timestamp)` internally. The `asset_vault` account is not required for read-only calls because `base_assets` and stream state fully determine the virtual balance.

| View | Accounts | Returns | Note |
|------|----------|---------|------|
| **total_assets** | vault | u64 | Returns effective_total_assets(now) |
| **total_supply** | shares_mint | u64 | Reads shares_mint.supply |
| **preview_deposit** | vault, shares_mint | shares: u64 | Uses effective_total_assets(now) |
| **preview_mint** | vault, shares_mint | assets: u64 | Uses effective_total_assets(now) |
| **preview_withdraw** | vault, shares_mint | shares: u64 | Uses effective_total_assets(now) |
| **preview_redeem** | vault, shares_mint | assets: u64 | Uses effective_total_assets(now) |
| **convert_to_shares** | vault, shares_mint | shares: u64 | Uses effective_total_assets(now) |
| **convert_to_assets** | vault, shares_mint | assets: u64 | Uses effective_total_assets(now) |
| **get_stream_info** | vault | StreamInfo | Returns base_assets, stream_amount, stream_start, stream_end, effective_total, last_checkpoint |

**Key difference**: `get_stream_info` is new in SVS-5. It exposes the full streaming state including the already-accrued amount at query time, useful for dashboards and off-chain monitors.

## Math

### Virtual Offset

```rust
offset = 10^decimals_offset
decimals_offset = 9 - asset_decimals  // Ensures 9-decimal precision
```

### Conversion (with virtual shares/assets)

Identical formulas to SVS-1 and SVS-2, but `total_assets` is always `effective_total_assets(now)`:

```rust
// Assets → Shares (floor)
shares = (assets * (total_supply + offset)) / (effective_total_assets(now) + 1)

// Shares → Assets (floor)
assets = (shares * (effective_total_assets(now) + 1)) / (total_supply + offset)
```

### Rounding

| Operation | Formula | Rounding | Rationale |
|-----------|---------|----------|-----------|
| **deposit** | `shares = convertToShares(assets)` | Floor | Favors vault |
| **mint** | `assets = convertToAssets(shares) + 1` | Ceiling | Favors vault |
| **withdraw** | `shares = convertToShares(assets) + 1` | Ceiling | Favors vault |
| **redeem** | `assets = convertToAssets(shares)` | Floor | Favors vault |

Same rounding rules as SVS-1 and SVS-2. The streaming model adds no new rounding edge cases — `accrued_stream_yield` is always floored, which protects existing shareholders.

## SDK Usage

### Class: `StreamingVault`

Extends `SolanaVault` from `@stbr/solana-vault` with SVS-5-specific methods:

```typescript
import { StreamingVault } from '@stbr/solana-vault';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com');
const authority = Keypair.fromSecretKey(/* ... */);

// Load existing vault
const vaultPubkey = new PublicKey('3XQX3ZKGcy618XyWMmQiukYohJNSh3JNWoffq8ZeFdcS');
const vault = await StreamingVault.load(connection, vaultPubkey);

// Read stream state
const info = await vault.getStreamInfo();
console.log(`base_assets:    ${info.baseAssets}`);
console.log(`stream_amount:  ${info.streamAmount}`);
console.log(`effective total: ${info.effectiveTotal}`);
console.log(`stream_end:     ${new Date(Number(info.streamEnd) * 1000).toISOString()}`);

// Distribute yield for 14 days (authority)
const FOURTEEN_DAYS = 14 * 24 * 60 * 60;
const distributeTx = await vault.distributeYield(
  authority.publicKey,
  yieldSourceAta,
  BigInt(10_000_000_000),  // 10,000 USDC (6 decimals: 10_000_000_000 = 10k at 6 dec)
  FOURTEEN_DAYS,
);
await connection.sendTransaction(distributeTx, [authority]);

// Checkpoint (permissionless — anyone can call)
const checkpointTx = await vault.checkpoint();
await connection.sendTransaction(checkpointTx, [anyKeypair]);

// Deposit (same interface as SVS-1/SVS-2)
const depositTx = await vault.deposit(
  user.publicKey,
  BigInt(1_000_000_000),  // 1,000 USDC
);
await connection.sendTransaction(depositTx, [user]);

// Preview at current timestamp
const shares = await vault.previewDeposit(BigInt(1_000_000_000));
console.log(`Expected shares: ${shares}`);
```

### Key Methods

```typescript
class StreamingVault extends SolanaVault {
  // SVS-5 specific
  async distributeYield(
    authority: PublicKey,
    yieldSource: PublicKey,
    amount: bigint,
    duration: number,
  ): Promise<Transaction>;

  async checkpoint(): Promise<Transaction>;

  async getStreamInfo(): Promise<{
    baseAssets: bigint;
    streamAmount: bigint;
    streamStart: bigint;
    streamEnd: bigint;
    effectiveTotal: bigint;      // base_assets + accrued stream yield
    lastCheckpoint: bigint;
  }>;

  // Inherited from SolanaVault (same interface as SVS-1/SVS-2)
  async deposit(depositor: PublicKey, assets: bigint): Promise<Transaction>;
  async mint(depositor: PublicKey, shares: bigint): Promise<Transaction>;
  async withdraw(owner: PublicKey, assets: bigint): Promise<Transaction>;
  async redeem(owner: PublicKey, shares: bigint): Promise<Transaction>;
  async previewDeposit(assets: bigint): Promise<bigint>;
  async previewMint(shares: bigint): Promise<bigint>;
  async previewWithdraw(assets: bigint): Promise<bigint>;
  async previewRedeem(shares: bigint): Promise<bigint>;
}
```

## Trust Model & Security

### Authority Powers

| Power | Risk | Mitigation |
|-------|------|-----------|
| **Set stream rate** | Authority could front-run by depositing just before `distribute_yield` at a lower share price | Auto-checkpoint on `distribute_yield` ensures no stale share price at stream start |
| **Control distribution timing** | Authority delays distributions to suppress share price growth | Agreed distribution schedules, on-chain monitoring, multisig governance |
| **Set stream duration** | Extremely short duration degrades smoothness to a jump (like `sync()`) | Enforce minimum duration (60 seconds); prefer durations measured in hours/days |
| **Pause vault** | Pausing traps depositors; streaming state is preserved through pause | Timelock on pause, governance controls |

**Authority cannot**: manipulate `base_assets` directly, call `checkpoint` exclusively (it is permissionless), or cause share price to decrease via `distribute_yield` (yield only adds to effective_total_assets).

### Clock Manipulation

Solana's `Clock::unix_timestamp` is validator-reported and can drift ±1–2 seconds. For streams measured in hours or days, this drift is negligible (sub-0.01% error at 1-day duration). For very short streams (seconds), accuracy degrades proportionally. The minimum duration of 60 seconds is enforced to keep clock jitter below 3% of the stream period in the worst case.

Validator collusion to significantly advance or retard the clock is a network-level attack that affects all time-dependent programs. SVS-5 is not uniquely exposed to this risk.

### Checkpoint Permissionlessness

Because `checkpoint` is permissionless:

- Anyone can materialize accrued yield at any time — there is no gatekeeper.
- MEV bots or keeper services can call `checkpoint` at stream end to clear stream state.
- There is no incentive for a malicious actor to avoid checkpointing, because the yield is already locked in `stream_amount` and will be reflected in `effective_total_assets(now)` regardless of whether `checkpoint` is called.

### Comparison to SVS-2 Sync Attack

The SVS-2 sync timing attack (withhold `sync()`, deposit at stale price, then sync to profit) does not apply to SVS-5:

| Attack Step | SVS-2 | SVS-5 |
|-------------|-------|-------|
| Yield accrues | Invisible until `sync()` | Visible immediately in `effective_total_assets(now)` |
| Front-run window | Between yield arrival and `sync()` | Does not exist |
| Authority advantage | Knows when `sync()` will occur | Rate is public; no discrete event to front-run |

### When to Use SVS-2 vs SVS-5

| Use SVS-2 (Stored Balance) | Use SVS-5 (Streaming) |
|----------------------------|-----------------------|
| Yield arrives as lump sums (strategy returns) | Yield is distributed continuously (payroll, vesting) |
| Authority timing trust is acceptable | Smooth, MEV-resistant share price required |
| Off-chain monitoring infrastructure available | Prefer self-enforcing on-chain mechanics |
| Simpler accounting preferred | Linear yield recognition required for compliance |

## Deployment

### Devnet

| Item | Value |
|------|-------|
| **Program ID** | `3XQX3ZKGcy618XyWMmQiukYohJNSh3JNWoffq8ZeFdcS` |
| **Network** | Devnet |
| **SDK Package** | `@stbr/solana-vault` |
| **Class** | `StreamingVault` |

### Verification

```bash
# Verify program deployment
solana program show 3XQX3ZKGcy618XyWMmQiukYohJNSh3JNWoffq8ZeFdcS --url devnet

# Anchor verify (if verifiable build available)
anchor verify 3XQX3ZKGcy618XyWMmQiukYohJNSh3JNWoffq8ZeFdcS --provider.cluster devnet
```

### Integration Example

```typescript
import { StreamingVault } from '@stbr/solana-vault';
import { Connection, PublicKey } from '@solana/web3.js';

const DEVNET_PROGRAM_ID = new PublicKey('3XQX3ZKGcy618XyWMmQiukYohJNSh3JNWoffq8ZeFdcS');
const connection = new Connection('https://api.devnet.solana.com');

// Derive StreamVault PDA
const assetMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC
const vaultId = BigInt(1);

const [vaultPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from('stream_vault'),
    assetMint.toBuffer(),
    Buffer.from(new Uint8Array(new BigUint64Array([vaultId]).buffer)),
  ],
  DEVNET_PROGRAM_ID
);

const vault = await StreamingVault.load(connection, vaultPda);

// Check whether a stream is currently active
const info = await vault.getStreamInfo();
const now = BigInt(Math.floor(Date.now() / 1000));

if (info.streamEnd > now) {
  const remainingSecs = info.streamEnd - now;
  const accrued = info.effectiveTotal - info.baseAssets;
  const remaining = info.streamAmount - accrued;
  console.log(`Stream active: ${remaining} tokens over ${remainingSecs}s remaining`);
} else {
  console.log('No active stream. Vault in idle state.');
}
```

---

## Yield Distribution Walkthrough

### Scenario: 2-Week Streaming Period

**Setup**:
- Initial vault balance: 1,000,000 USDC
- Stream yield: 10,000 USDC
- Stream duration: 14 days (1,209,600 seconds)
- Depositors: Alice holds 1,000 shares at Day 0

**Day 0**: Authority calls `distribute_yield(10_000_000_000, 1_209_600)`

```
stream_amount = 10,000 USDC
stream_start  = T₀
stream_end    = T₀ + 1,209,600
base_assets   = 1,000,000 USDC  (unchanged)
```

**Day 7** (T₀ + 604,800 seconds): User queries share price

```
elapsed  = 604,800
accrued  = 10,000 × (604,800 / 1,209,600) = 5,000 USDC
effective_total_assets = 1,000,000 + 5,000 = 1,005,000 USDC
```

A depositor entering at Day 7 buys shares at 1,005 USDC/share (assuming 1,000 shares outstanding).

**Day 14** (T₀ + 1,209,600 seconds): Stream ends

```
accrued  = 10,000 × (1,209,600 / 1,209,600) = 10,000 USDC
effective_total_assets = 1,000,000 + 10,000 = 1,010,000 USDC
```

Anyone calls `checkpoint()`:

```
base_assets  = 1,010,000 USDC
stream_amount = 0
```

**Day 14+**: Authority distributes next period's yield

```
distribute_yield(10_000_000_000, 1_209_600)
  → No active stream to auto-checkpoint (stream_amount already 0)
  → New stream starts immediately
```

**Key observation**: Share price increased monotonically from 1,000 to 1,010 USDC over the 14 days. No user could gain an advantage by timing a `sync()` call.

### State Transitions

```
┌─────────────────────────────────────────────────────────────────┐
│                         IDLE STATE                              │
│  stream_amount = 0   OR   stream_end <= now                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ distribute_yield(amount, duration)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      STREAMING STATE                            │
│  stream_amount > 0,  stream_start < now < stream_end           │
│  effective_total_assets = base_assets + accrued(now)           │
└─────────────────────────────────────────────────────────────────┘
        │                      │                          │
        │ checkpoint()          │ now >= stream_end        │ distribute_yield()
        │ (partial)             │                          │ (auto-checkpoints)
        ▼                      ▼                          ▼
┌───────────────┐    ┌──────────────────┐    ┌───────────────────────┐
│ STREAMING     │    │ IDLE STATE       │    │ NEW STREAMING STATE   │
│ (stream_start │    │ (stream complete) │    │ (previous finalized)  │
│  advanced)    │    └──────────────────┘    └───────────────────────┘
└───────────────┘
```

### Sync vs Arithmetic Updates

| Event | base_assets Update | stream_amount Update |
|-------|-------------------|---------------------|
| `deposit(1000)` | `+= 1000` | Unchanged |
| `withdraw(500)` | `-= 500` | Unchanged |
| `distribute_yield(10000, dur)` | Unchanged (stream starts) | `= 10000` |
| `checkpoint()` partial | `+= accrued` | `-= accrued` |
| `checkpoint()` at stream end | `+= stream_amount` | `= 0` |

### Keeper Bot Pattern

```typescript
// Checkpoint keeper — call at stream end
async function checkpointKeeper(vault: StreamingVault, connection: Connection) {
  while (true) {
    const info = await vault.getStreamInfo();
    const now = BigInt(Math.floor(Date.now() / 1000));

    if (info.streamEnd <= now && info.streamAmount > 0n) {
      console.log('Stream ended, checkpointing...');
      const tx = await vault.checkpoint();
      await connection.sendTransaction(tx, [keeper]);
    }

    await sleep(60_000);  // Poll every minute
  }
}

// Event-driven pattern — watch for stream end
const slot = await connection.getSlot();
connection.onProgramAccountChange(PROGRAM_ID, async () => {
  const info = await vault.getStreamInfo();
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (info.streamEnd <= now && info.streamAmount > 0n) {
    await vault.checkpoint();
  }
});
```

---

## Error Codes

In addition to [core errors](ERRORS.md):

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6011 | `StreamTooShort` | Stream duration below minimum (60 seconds) | `distribute_yield` with duration < 60 |
| 6012 | `StreamAlreadyActive` | Cannot start stream while one is active — checkpoint first | Reserved; auto-checkpoint handles this case |

---

## Compute Units

`effective_total_assets` adds one `mul_div` call (u128 intermediate) per instruction compared to SVS-1's direct balance read or SVS-2's stored field read. Overhead is approximately 200 CU per call.

| Instruction | Approximate CU | Notes |
|-------------|---------------|-------|
| `initialize` | ~25,000 | Create vault + shares mint + asset vault |
| `deposit` | ~30,000 | Includes effective_total_assets computation |
| `mint` | ~30,000 | Includes effective_total_assets computation |
| `withdraw` | ~35,000 | Includes effective_total_assets computation |
| `redeem` | ~35,000 | Includes effective_total_assets computation |
| `distribute_yield` | ~20,000 | Auto-checkpoint adds ~8,000 if stream active |
| `checkpoint` | ~8,000 | Simple state update |
| `pause` / `unpause` | ~5,000 | Single field write |
| `transfer_authority` | ~5,000 | Single field write |
| `effective_total_assets` | ~200 | Added overhead per instruction |

---

## Module Integration

SVS-5 supports the same module system as SVS-1 and SVS-2. Build with `anchor build -- --features modules`.

Module hooks integrate at the same call sites as other variants, with one SVS-5-specific consideration: modules that reference `total_assets` (fees, caps) receive `effective_total_assets(now)` rather than a stored or live balance.

| Module | SVS-5 Behavior |
|--------|----------------|
| **svs-fees** | Management fees accrue on `effective_total_assets(now)` |
| **svs-caps** | Deposit caps checked against `effective_total_assets(now) + deposit_amount` |
| **svs-locks** | ShareLock created on deposit, checked on redeem — works identically to SVS-1 |
| **svs-rewards** | Secondary rewards run independently of streaming yield; both can be active simultaneously |
| **svs-access** | Whitelist/blacklist/freeze checks on every financial instruction — unchanged |

See [SVS-1.md#module-integration](SVS-1.md#module-integration) for hook architecture and [specs-modules.md](specs-modules.md) for full module specification.

---

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/svs-5/src/lib.rs` | Program entry |
| `programs/svs-5/src/state.rs` | StreamVault account struct |
| `programs/svs-5/src/math.rs` | effective_total_assets, mul_div |
| `programs/svs-5/src/instructions/distribute_yield.rs` | distribute_yield handler |
| `programs/svs-5/src/instructions/checkpoint.rs` | checkpoint handler |
| `programs/svs-5/src/instructions/deposit.rs` | deposit handler |
| `programs/svs-5/src/instructions/mint.rs` | mint handler |
| `programs/svs-5/src/instructions/withdraw.rs` | withdraw / redeem handlers |
| `programs/svs-5/src/instructions/admin.rs` | pause, unpause, transfer_authority |
| `programs/svs-5/src/error.rs` | VaultError enum |
| `programs/svs-5/src/events.rs` | YieldStreamStarted, Checkpoint events |
| `svs-module-hooks/` (shared crate) | Module integration (with `modules` feature) |

---

**See Also**:
- [SVS-1.md](./SVS-1.md) — Live balance model
- [SVS-2.md](./SVS-2.md) — Stored balance with sync()
- [SVS-6.md](./specs-SVS06.md) — Streaming + Confidential variant
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design
- [PATTERNS.md](./PATTERNS.md) — Implementation patterns
- [ERRORS.md](./ERRORS.md) — Full error code reference
