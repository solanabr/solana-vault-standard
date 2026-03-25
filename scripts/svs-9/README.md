# SVS-9 CLI Scripts

CLI test scripts for the SVS-9 Allocator Vault.

## Scripts

| Script | Command | Description |
|---|---|---|
| `deposit.ts` | `npm run test-svs9:deposit` | Deposit assets → receive allocator shares |
| `redeem.ts` | `npm run test-svs9:redeem` | Burn shares → receive assets back (+ slippage test) |
| `harvest.ts` | `npm run test-svs9:harvest` | Full E2E harvest against a real child SVS-1 vault |
| `deallocate.ts` | `npm run test-svs9:deallocate` | Full E2E principal deallocation against a real child SVS-1 vault |

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
3. Built IDLs: `anchor build -p svs_1 && anchor build -p svs_9`

## Notes

- All four scripts are **self-contained** and create the required mints and vaults on the selected cluster.
- `harvest.ts` and `deallocate.ts` initialize a real `SVS-1` child vault before executing the CPI path.
