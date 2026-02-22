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
| **Sync Exploit** | `sync.ts` | ⚠️ Tests sync() timing attack vector |

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
yarn test-svs1:sync-exploit
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
│     └── (Protected because sync() not called)                   │
│                                                                 │
│  6. sync.ts ⚠️                                                  │
│     └── Tests what happens if sync() IS called                  │
│     └── Donation + sync before victim = EXPLOIT                 │
│     └── Documents the attack vector for audit                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Known Issues for Audit

### Sync Timing Attack (sync.ts)

**Severity:** Medium-High (requires authority collusion)

**Attack Flow:**
1. Attacker deposits minimal amount (1 token)
2. Attacker donates large amount directly to vault
3. Authority calls `sync()` (malicious or compromised)
4. `total_assets` jumps to include donation
5. Victim deposits → receives almost 0 shares
6. Attacker's shares now worth entire vault

**Current Mitigations:**
- `sync()` is admin-only
- Donations don't affect share price until sync

**Recommended Fixes:**
- Add timelock to sync()
- Emit events on significant total_assets changes
- Consider minimum share output in deposit()
- Document sync() should only be for legitimate yield

## File Structure

```
scripts/svs-1/
├── helpers.ts          # Shared utilities, SOL funding, setup
├── basic.ts            # Core functionality test
├── slippage.ts         # Slippage protection test
├── multi-user.ts       # Multi-user fairness test
├── edge-cases.ts       # Error handling test
├── inflation-attack.ts # Donation attack test (without sync)
├── sync.ts             # Sync timing attack test
└── README.md           # This file
```

## Prerequisites

- SVS-1 deployed to devnet (`anchor deploy --provider.cluster devnet`)
- Wallet funded with ~2 SOL
- Dependencies installed (`yarn install`)
