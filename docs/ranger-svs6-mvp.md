# Ranger MVP Plan: SVS-6 Native SOL Streaming Yield

## Goal

Ship a runnable SVS-6 milestone for Ranger hackathon demos:
- Native SOL deposit/withdraw with ERC-4626 share semantics
- Streaming yield distribution (`distribute_yield`) and accrual checkpoint (`accrue_yield`)
- Anchor tests + SDK wrapper + demo script

## Scope Implemented

1. `programs/svs-6` added as a new Anchor program.
2. Native SOL asset flows implemented in:
   - `deposit`
   - `mint`
   - `withdraw`
   - `redeem`
3. Yield streaming implemented in:
   - `distribute_yield`
   - `accrue_yield` (and `checkpoint` alias)
4. SDK wrapper added:
   - `sdk/core/src/native-sol-stream-vault.ts`
5. Demo script added:
   - `scripts/svs-6/native-sol-demo.ts`
6. Anchor integration test added:
   - `tests/svs-6.ts`

## Reproducible Commands

```bash
# Build only SVS-6
anchor build -p svs-6

# Run the SVS-6 Anchor test
anchor test --skip-build -- tests/svs-6.ts

# Run SDK TypeScript compile (if SDK was touched)
yarn workspace @stbr/solana-vault build

# Optional demo flow (local validator or configured cluster)
npx ts-node scripts/svs-6/native-sol-demo.ts 1 --init
```

## Devnet Deployment Checklist

```bash
solana config set --url devnet
solana airdrop 2
anchor build -p svs-6
anchor deploy -p svs-6 --provider.cluster devnet
anchor idl fetch GuBDfEKriv9ZYMfneTFHQ9zqc3W79fF78YfAL79mBJVb > target/idl/svs_6.devnet.json
```

Post-deploy checks:
1. Confirm deployed program id matches `GuBDfEKriv9ZYMfneTFHQ9zqc3W79fF78YfAL79mBJVb`.
2. Run `scripts/svs-6/native-sol-demo.ts` against devnet.
3. Capture tx links for initialize/deposit/distribute/accrue/withdraw.

## Video Demo Outline (2-3 min)

1. Problem framing: "yield vault UX is worse when users must wrap SOL first."
2. Show SVS-6 vault initialize (CLI/terminal + tx signature).
3. Show native SOL deposit (no SPL token account prep).
4. Show authority `distribute_yield` and wait briefly.
5. Show `accrue_yield` and increased `base_assets`.
6. Show user withdraw and explain share burn / vault-favoring rounding.
7. Close with SDK snippet (`NativeSolStreamVault`) and next milestone items.

## Next Engineering Steps

1. Add dedicated `deposit_sol` / `withdraw_sol` aliases for clearer UX naming.
2. Add invariant tests (share price monotonicity during active stream).
3. Add devnet smoke test automation for CI artifacts.
