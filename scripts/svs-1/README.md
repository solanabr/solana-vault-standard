# SVS-1 Test Scripts

Pre-audit test suite for SVS-1 (Public Vault) on devnet.

## Test Coverage

| Test | Script | What It Validates |
|------|--------|-------------------|
| **Basic** | `basic.ts` | Core vault operations: init, deposit, redeem, pause/unpause |
| **Slippage** | `slippage.ts` | Min/max slippage params prevent sandwich attacks |
| **Multi-User** | `multi-user.ts` | Fair share distribution across multiple depositors |
| **Edge Cases** | `edge-cases.ts` | Error handling: zero amounts, unauthorized access, excess redemption |
| **Inflation Attack** | `inflation-attack.ts` | Protection against donation-based share manipulation |
| **Live Balance** | `live-balance.ts` | Tests live balance behavior: donations, share price, no sync |
| **Withdraw/Mint** | `withdraw-mint.ts` | Tests withdraw and mint operations with slippage |
| **View Functions** | `view-functions.ts` | Tests all view functions (empty, funded, paused vault) |
| **Full Drain** | `full-drain.ts` | Tests complete vault drain and re-deposit scenarios |

## Quick Start

```bash
# 1. Set environment
export RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
export ANCHOR_WALLET="/path/to/your-keypair.json"  # optional

# 2. Run all tests
yarn test-svs1:all

# 3. Or run individual tests
yarn test-svs1:basic
yarn test-svs1:slippage
yarn test-svs1:multi-user
yarn test-svs1:edge-cases
yarn test-svs1:inflation-attack
yarn test-svs1:live-balance
yarn test-svs1:withdraw-mint
yarn test-svs1:view-functions
yarn test-svs1:full-drain
```

## Test Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     SVS-1 Test Suite                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. basic.ts                                                    │
│     └── Deposit → Shares received                               │
│     └── Redeem → Assets returned                                │
│     └── Pause blocks operations                                 │
│                                                                 │
│  2. slippage.ts                                                 │
│     └── deposit(minSharesOut too high) → REVERT ✓               │
│     └── mint(maxAssetsIn too low) → REVERT ✓                    │
│     └── withdraw(maxSharesIn too low) → REVERT ✓                │
│     └── redeem(minAssetsOut too high) → REVERT ✓                │
│                                                                 │
│  3. multi-user.ts                                               │
│     └── Alice deposits 10k → gets proportional shares           │
│     └── Bob deposits 5k → gets proportional shares              │
│     └── Charlie deposits 20k → gets proportional shares         │
│     └── All redeem → everyone gets fair value back              │
│                                                                 │
│  4. edge-cases.ts                                               │
│     └── Zero amount → REVERT ✓                                  │
│     └── Unauthorized pause → REVERT ✓                           │
│     └── Deposit when paused → REVERT ✓                          │
│     └── Excess redemption → REVERT ✓                            │
│     └── Authority transfer → old blocked, new works             │
│     └── Multi-vault isolation → separate accounting             │
│                                                                 │
│  5. inflation-attack.ts                                         │
│     └── Attacker deposits 1 token                               │
│     └── Attacker donates 1M directly to vault                   │
│     └── Victim deposits 1000 → gets FAIR shares ✓               │
│     └── Virtual offset protection verified                      │
│                                                                 │
│  6. live-balance.ts                                             │
│     └── Donation immediately visible                            │
│     └── Share price increases after donation                    │
│     └── New depositor gets fewer shares (fair pricing)          │
│     └── SVS-1 has no sync() instruction                         │
│                                                                 │
│  7. withdraw-mint.ts                                            │
│     └── mint() happy path + slippage protection                 │
│     └── withdraw() happy path + slippage protection             │
│     └── deposit/mint and withdraw/redeem consistency            │
│                                                                 │
│  8. view-functions.ts                                           │
│     └── All view functions on empty vault                       │
│     └── All view functions on funded vault                      │
│     └── View functions work when paused                         │
│                                                                 │
│  9. full-drain.ts                                               │
│     └── Single user drain + multi-user drain                    │
│     └── Re-deposit after drain works                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

```
scripts/svs-1/
├── helpers.ts          # Shared utilities, SOL funding, setup
├── basic.ts            # Core functionality test
├── slippage.ts         # Slippage protection test
├── multi-user.ts       # Multi-user fairness test
├── edge-cases.ts       # Error handling test
├── inflation-attack.ts # Donation attack test (virtual offset protection)
├── live-balance.ts     # Live balance behavior test
├── withdraw-mint.ts    # Withdraw and mint operations test
├── view-functions.ts   # View functions test (empty, funded, paused)
├── full-drain.ts       # Full drain and re-deposit test
└── README.md           # This file
```

## Prerequisites

- SVS-1 deployed to devnet (`anchor deploy --provider.cluster devnet`)
- Wallet funded with ~2 SOL
- Dependencies installed (`yarn install`)
