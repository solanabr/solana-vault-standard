# SVS-9 CLI Scripts

CLI test scripts for the SVS-9 Allocator Vault.

## Scripts

| Script | Command | Description |
|---|---|---|
| `deposit.ts` | `npm run test-svs9:deposit` | Deposit assets → receive allocator shares |
| `redeem.ts` | `npm run test-svs9:redeem` | Burn shares → receive assets back (+ slippage test) |
| `harvest.ts` | `npm run test-svs9:harvest` | Harvest yield from child vault (demo) |
| `deallocate.ts` | `npm run test-svs9:deallocate` | Withdraw principal from child vault (demo) |

## Running

```bash
# Individual scripts
npx ts-node scripts/svs-9/deposit.ts
npx ts-node scripts/svs-9/redeem.ts
npx ts-node scripts/svs-9/harvest.ts
npx ts-node scripts/svs-9/deallocate.ts

# All SVS-9 scripts
npm run test-svs9:all
```

## Prerequisites

1. Solana CLI configured for devnet: `solana config set --url devnet`
2. Funded wallet: `solana airdrop 2`
3. Built IDL: `anchor build -p svs_9`

## Notes

- `deposit.ts` and `redeem.ts` are **fully self-contained** — they create mints, initialize vaults, and execute the full flow.
- `harvest.ts` and `deallocate.ts` require **live child vaults** for CPI. They demonstrate the account structure and call pattern. For a full E2E test, use `anchor test -- tests/svs-9.ts`.
