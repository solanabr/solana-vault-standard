# SVS-5 Test Scripts

Pre-audit test suite for SVS-5 (Streaming Yield Vault) on devnet.

## Test Coverage

| Test | Script | What It Validates |
|------|--------|-------------------|
| **Basic** | `basic.ts` | Core vault operations: init, deposit, distribute_yield, checkpoint, redeem, pause/unpause |
| **Slippage** | `slippage.ts` | Min/max slippage params during active yield stream |
| **Multi-User** | `multi-user.ts` | Fair share distribution: pre-stream vs mid-stream deposits |
| **Edge Cases** | `edge-cases.ts` | Error handling: zero amounts, short streams, unauthorized yield, stream replacement |
| **Inflation Attack** | `inflation-attack.ts` | Protection against donation-based share manipulation during streaming |
| **Live Balance** | `live-balance.ts` | Streaming balance: linear interpolation, checkpoint, share price growth |
| **Withdraw/Mint** | `withdraw-mint.ts` | Withdraw and mint operations during active yield stream |
| **View Functions** | `view-functions.ts` | All view functions (empty, funded, streaming, paused) + getStreamInfo |
| **Full Drain** | `full-drain.ts` | Complete vault drain after stream + re-deposit scenarios |

## Quick Start

```bash
# 1. Set environment
export RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
export ANCHOR_WALLET="/path/to/your-keypair.json"  # optional

# 2. Run individual tests
npx ts-node scripts/svs-5/basic.ts
npx ts-node scripts/svs-5/slippage.ts
npx ts-node scripts/svs-5/multi-user.ts
npx ts-node scripts/svs-5/edge-cases.ts
npx ts-node scripts/svs-5/inflation-attack.ts
npx ts-node scripts/svs-5/live-balance.ts
npx ts-node scripts/svs-5/withdraw-mint.ts
npx ts-node scripts/svs-5/view-functions.ts
npx ts-node scripts/svs-5/full-drain.ts
```

## Test Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     SVS-5 Test Suite                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. basic.ts                                                    │
│     └── Deposit → Shares received                               │
│     └── Distribute yield → Stream started                       │
│     └── Checkpoint → Yield materialized                         │
│     └── Redeem → Assets + yield returned                        │
│     └── Pause blocks operations                                 │
│                                                                 │
│  2. slippage.ts                                                 │
│     └── deposit(minSharesOut too high) during stream → REVERT ✓ │
│     └── mint(maxAssetsIn too low) during stream → REVERT ✓      │
│     └── withdraw(maxSharesIn too low) during stream → REVERT ✓  │
│     └── redeem(minAssetsOut too high) during stream → REVERT ✓  │
│                                                                 │
│  3. multi-user.ts                                               │
│     └── Alice deposits before stream → more shares              │
│     └── Yield stream starts                                     │
│     └── Bob deposits mid-stream → fewer shares (fair pricing)   │
│     └── Both redeem → Alice gets more yield                     │
│                                                                 │
│  4. edge-cases.ts                                               │
│     └── Zero amount → REVERT ✓                                  │
│     └── Zero yield → REVERT ✓                                   │
│     └── Duration < 60s → REVERT (StreamTooShort) ✓              │
│     └── Checkpoint with no stream → no-op ✓                     │
│     └── Unauthorized distribute_yield → REVERT ✓                │
│     └── New stream replaces active (auto-checkpoint) ✓          │
│     └── Deposit when paused → REVERT ✓                          │
│     └── Authority transfer → old blocked ✓                      │
│                                                                 │
│  5. inflation-attack.ts                                         │
│     └── Attacker deposits 1 token                               │
│     └── Yield stream starts                                     │
│     └── Attacker donates 1M directly to vault                   │
│     └── Victim deposits → gets FAIR shares ✓                    │
│     └── Virtual offset protection verified during streaming     │
│                                                                 │
│  6. live-balance.ts                                             │
│     └── Initial state correct (base_assets = deposit)           │
│     └── Stream starts, parameters recorded                      │
│     └── Yield accrues over time (verified via checkpoint)       │
│     └── Stream amount decreases after checkpoint                │
│     └── Share price increases from yield                        │
│                                                                 │
│  7. withdraw-mint.ts                                            │
│     └── mint() mid-stream → correct shares/assets               │
│     └── withdraw() mid-stream → correct shares/assets           │
│     └── Vault state consistent after operations                 │
│                                                                 │
│  8. view-functions.ts                                           │
│     └── All view functions on empty vault                       │
│     └── All view functions on funded vault                      │
│     └── getStreamInfo during active stream                      │
│     └── View functions work when paused                         │
│                                                                 │
│  9. full-drain.ts                                               │
│     └── Single user drain after stream completes                │
│     └── Multi-user drain with yield distribution                │
│     └── Re-deposit after drain works                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

```
scripts/svs-5/
├── helpers.ts          # SVS-5 specific helpers, setup
├── basic.ts            # Core functionality + streaming yield
├── slippage.ts         # Slippage protection during streaming
├── multi-user.ts       # Multi-user fairness with streaming yield
├── edge-cases.ts       # SVS-5 specific error handling
├── inflation-attack.ts # Donation attack during streaming
├── live-balance.ts     # Streaming balance behavior (linear interpolation)
├── withdraw-mint.ts    # Withdraw/mint during active stream
├── view-functions.ts   # View functions (empty, funded, streaming, paused)
├── full-drain.ts       # Full drain after stream + re-deposit
└── README.md           # This file
```

## Prerequisites

- SVS-5 deployed to devnet (`anchor deploy --provider.cluster devnet`)
- Wallet funded with ~2 SOL
- Dependencies installed (`yarn install`)

## Key Differences from SVS-1

SVS-5 uses **time-interpolated yield distribution** instead of live balance:
- `distribute_yield(amount, duration)` starts a linear yield stream
- `effective_total_assets = base_assets + accrued_stream_yield`
- `checkpoint()` materializes accrued yield into `base_assets`
- No need for sync() — yield accrues automatically over time
- Eliminates MEV from front-running discrete sync/yield operations
