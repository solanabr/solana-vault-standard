# SVS-6: Confidential Streaming Yield Vault

## Overview

SVS-6 combines time-interpolated streaming yield distribution (SVS-5) with Token-2022 Confidential Transfers (SVS-3). Yield streams linearly over a configurable period, preventing sandwich attacks on yield distribution. Individual share balances are encrypted using ElGamal encryption, hiding per-user positions while keeping aggregate vault metrics public.

## Relationship to Other Variants

```
                    Public          Confidential
                    ──────          ────────────
Live Balance        SVS-1           SVS-3
Stored (Sync)       SVS-2           SVS-4
Streaming           SVS-5           SVS-6  ←
```

SVS-6 = SVS-5 streaming math + SVS-3 confidential transfer mechanics.

## Balance Model

**Streaming Balance**: `effective_total_assets = base_assets + accrued_yield`

```rust
elapsed = min(now - stream_start, stream_end - stream_start)
duration = stream_end - stream_start
accrued = stream_amount × elapsed / duration

effective_total_assets = base_assets + accrued
```

- `base_assets` updated arithmetically by deposit/withdraw and settled by checkpoint()
- `stream_amount` decreases as yield is checkpointed
- No sync() needed — streaming replaces sync-based yield recognition
- Checkpoint is permissionless — anyone can call it

## Privacy Model

**What's Hidden:**
- Individual share balances (encrypted with ElGamal)

**What's Public:**
- Total vault assets (effective_total_assets)
- Total shares supply
- Share price (calculable from above)
- Streaming parameters (base_assets, stream_amount, stream_start, stream_end)
- Deposit/withdraw asset amounts (SPL token transfers are visible)

## Account Structure

### PDAs

| Account | Seeds | Purpose |
|---------|-------|---------|
| Vault | `["confidential_stream_vault", asset_mint, vault_id.to_le_bytes()]` | Vault state (294 bytes on-chain) |
| Shares Mint | `["shares", vault_pubkey]` | Token-2022 mint with CT extension |
| Asset Vault | ATA(asset_mint, vault PDA) | Holds deposited assets |

### State: ConfidentialStreamVault (286 bytes)

```rust
#[account]
pub struct ConfidentialStreamVault {
    // ── Core fields ──
    pub authority: Pubkey,                        // 32B
    pub asset_mint: Pubkey,                       // 32B
    pub shares_mint: Pubkey,                      // 32B
    pub asset_vault: Pubkey,                      // 32B
    pub decimals_offset: u8,                      // 1B
    pub bump: u8,                                 // 1B
    pub paused: bool,                             // 1B
    pub vault_id: u64,                            // 8B

    // ── Streaming fields ──
    pub base_assets: u64,                         // 8B
    pub total_shares: u64,                        // 8B
    pub stream_amount: u64,                       // 8B
    pub stream_start: i64,                        // 8B
    pub stream_end: i64,                          // 8B
    pub last_checkpoint: i64,                     // 8B

    // ── Confidential fields ──
    pub auditor_elgamal_pubkey: Option<[u8; 32]>, // 33B
    pub confidential_authority: Pubkey,           // 32B

    pub _reserved: [u8; 32],                      // 32B
}
```

**Size comparison:**

| Variant | Account Size |
|---------|-------------|
| SVS-1 Vault | 219 bytes |
| SVS-3 ConfidentialVault | 252 bytes |
| SVS-5 StreamVault | 243 bytes |
| SVS-6 ConfidentialStreamVault | 286 bytes |

## Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize` | Authority | Creates vault PDA, CT-enabled shares mint, asset vault ATA |
| `configure_account` | User | One-time CT setup — registers ElGamal key on shares account |
| `deposit` | User | Deposits assets, mints encrypted shares at streaming price |
| `mint` | User | Mints exact encrypted shares, pays required assets |
| `withdraw` | User | Withdraws exact assets, burns encrypted shares + ZK proofs |
| `redeem` | User | Redeems encrypted shares + ZK proofs |
| `apply_pending` | User | Moves CT shares from pending to available balance |
| `distribute_yield` | Authority | Starts a new yield stream over specified duration |
| `checkpoint` | **Permissionless** | Settles accrued yield into base_assets |
| `pause` | Authority | Emergency pause — blocks all core operations |
| `unpause` | Authority | Resume operations |
| `transfer_authority` | Authority | Transfer admin rights (works when paused) |

### Confidential Withdraw/Redeem

Same two-transaction pattern as SVS-3:

1. Create proof context state accounts (equality + range proofs)
2. Call checkpoint() + withdraw/redeem in the same transaction
3. (Optional) Close proof context accounts to recover rent

Additional parameter: `new_decryptable_available_balance: [u8; 36]` — AES-encrypted post-operation balance for client-side display.

## Streaming Yield

### How It Works

Authority calls `distribute_yield(amount, duration_seconds)` to start a yield stream. The effective total assets increases linearly from `base_assets` to `base_assets + amount` over `duration_seconds`.

### Checkpoint

Settles accrued yield into base_assets:

```
Before: base_assets=10000, stream_amount=1000, 3 days into 7-day stream
After:  base_assets=10428, stream_amount=572, stream_start=now
```

### Why Checkpoint Before Withdraw

The streaming math changes every second. Calling checkpoint() immediately before withdraw in the same transaction ensures the proof generated client-side matches the on-chain state at execution time.

## View Functions

| Function | Returns | Notes |
|----------|---------|-------|
| `total_assets` | effective_total_assets(now) | Includes streaming yield |
| `preview_deposit(assets)` | Expected shares | Floor rounding |
| `preview_mint(shares)` | Required assets | Ceiling rounding |
| `preview_withdraw(assets)` | Required shares | Ceiling rounding |
| `preview_redeem(shares)` | Expected assets | Floor rounding |
| `max_deposit` | Vault total assets | Upper bound (encrypted balances) |
| `max_withdraw` | Vault total assets | Upper bound |
| `max_redeem` | u64::MAX | Can't read encrypted balance |

No `VaultViewWithOwner` context — encrypted balances are unreadable on-chain. SDK handles per-user previews client-side.

## Module Compatibility

Build with `anchor build -- --features modules`.

| Module | Compatible | Notes |
|--------|-----------|-------|
| svs-fees | Yes | Fees computed on plaintext amounts before CT |
| svs-caps | Partial | Per-user caps use plaintext UserDeposit PDA workaround |
| svs-locks | Full | Timestamps are not balance-dependent |
| svs-access | Full | Identity checks, not balance checks |
| svs-rewards | Full | Separate reward token, no CT interaction |

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000–6010 | Base errors | See [ERRORS.md](ERRORS.md) |
| 6020 | InvalidProof | ZK proof verification failed |
| 6021 | ProofContextMismatch | Wrong proof context account |
| 6022 | PendingBalanceNotEmpty | Must apply pending first |
| 6023 | ConfidentialTransferDisabled | CT not configured on account |
| 6030 | NoActiveStream | No yield stream to checkpoint |
| 6031 | StreamStillActive | Stream in progress |
| 6032 | InvalidStreamDuration | Duration outside valid range |
| 6033 | ZeroStreamAmount | Stream amount must be > 0 |
| 6034 | InsufficientAssetsForStream | Not enough assets for stream |

## Compute Units

| Instruction | CU | Notes |
|-------------|-----|-------|
| initialize | ~30,000 | Vault + CT-enabled shares mint |
| configure_account | ~80,000 | PubkeyValidityProof verification |
| deposit/mint | ~50,000 | Streaming math + CT mint |
| checkpoint | ~8,000 | State update only |
| distribute_yield | ~25,000 | May auto-checkpoint |
| withdraw/redeem | ~185,000 | Streaming + equality + range proofs |
| apply_pending | ~40,000 | CT balance finalization |

**Warning:** Withdraw/redeem at ~185k CU approach the 200k default limit. Modules may require `SetComputeUnitLimit`.

## Security Considerations

- **Inflation attack**: Virtual offset protection (same as all SVS variants)
- **Sandwich attack**: Streaming yield prevents MEV extraction on yield distribution
- **Checkpoint atomicity**: Always call checkpoint() in same tx as withdraw
- **Total shares leakage**: Aggregate metrics public, individual positions encrypted
- **Streaming manipulation**: distribute_yield is authority-only — use multisig/governance

## Deployment

| Network | Program ID | Status |
|---------|-----------|--------|
| Devnet | TBD | Pending deployment |
| Mainnet | Not deployed | Pending audit |

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/svs-6/src/lib.rs` | Program entry point |
| `programs/svs-6/src/state.rs` | ConfidentialStreamVault struct |
| `programs/svs-6/src/constants.rs` | PDA seeds, limits |
| `programs/svs-6/src/error.rs` | Error codes |
| `programs/svs-6/src/events.rs` | Event definitions |
| `programs/svs-6/src/math.rs` | Streaming + share conversion math |
| `programs/svs-6/src/instructions/` | Instruction handlers |

## See Also

- [SVS-5.md](./SVS-5.md) — Base streaming yield vault (public balances)
- [SVS-3.md](./SVS-3.md) — Confidential transfer implementation
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design
- [PATTERNS.md](./PATTERNS.md) — Implementation patterns
- [specs-modules.md](./specs-modules.md) — Module system specification
