# SVS Test Scripts

Pre-audit devnet test suites for Solana Vault Standard programs.

## Structure

```
scripts/
├── svs-1/                    # SVS-1 (Public Vault) tests
│   ├── helpers.ts            # Shared utilities
│   ├── basic.ts              # Core functionality
│   ├── slippage.ts           # Slippage protection
│   ├── multi-user.ts         # Multi-user fairness
│   ├── edge-cases.ts         # Error handling
│   ├── inflation-attack.ts   # Donation attack (without sync)
│   ├── sync.ts               # ⚠️ Sync timing attack
│   └── README.md             # Detailed documentation
└── svs-2/                    # SVS-2 (Confidential) tests (coming soon)
```

## Quick Start

```bash
# Set your RPC endpoint (avoid public rate limits)
export RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"

# Optional: custom wallet
export ANCHOR_WALLET="/path/to/keypair.json"

# Run all SVS-1 tests
yarn test-svs1:all
```

## Available Commands

| Command | Description |
|---------|-------------|
| `yarn test-svs1:all` | Run complete SVS-1 test suite |
| `yarn test-svs1:basic` | Core vault operations |
| `yarn test-svs1:slippage` | Slippage protection checks |
| `yarn test-svs1:multi-user` | Multi-user fairness |
| `yarn test-svs1:edge-cases` | Error handling & edge cases |
| `yarn test-svs1:inflation-attack` | Donation attack protection |
| `yarn test-svs1:sync-exploit` | ⚠️ Sync timing vulnerability |

## Test Results Summary

After running `yarn test-svs1:all`, you should see:

- ✅ Basic: All operations work
- ✅ Slippage: 6/6 checks pass
- ✅ Multi-User: Fair share distribution
- ✅ Edge Cases: 6/6 error cases handled
- ✅ Inflation Attack: Protected (without sync)
- ⚠️ Sync Exploit: Documents known attack vector

## Known Issues

See [svs-1/README.md](./svs-1/README.md#known-issues-for-audit) for documented vulnerabilities to address before mainnet.
