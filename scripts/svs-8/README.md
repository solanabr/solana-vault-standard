# SVS-8 Scripts

Devnet scripts for the Multi-Asset Basket Vault.

## Prerequisites
```bash
anchor build
solana config set --url devnet
```

## Scripts

### basic.ts — Core functionality
```bash
npx ts-node scripts/svs-8/basic.ts
```
Initializes a vault, adds 2 assets, sets oracle prices, deposits, and redeems.

### edge-cases.ts — Security & error conditions
```bash
npx ts-node scripts/svs-8/edge-cases.ts
```
Tests rejection of invalid inputs: below minimum deposit, paused vault, wrong oracle.

## Environment Variables
```bash
RPC_URL=https://api.devnet.solana.com
ANCHOR_WALLET=~/.config/solana/id.json
```
