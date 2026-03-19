# SVS-6 Marginfi mSOL Integration Notes

This note captures the `ranger-build-bear-vault` MVP pattern and how it maps into this repository's SVS-6 branch work.

## Reference Scope

- Reference project: `/home/upopo/workspace/projects/ranger-build-bear-vault`
- Pattern: mSOL-only deposits routed through Marginfi liquidity path.
- Key formulas reused in SDK helpers:
  - Deposit share mint:
    - first deposit: `shares = amount`
    - later: `shares = amount * total_shares / marginfi_assets_before`
  - Withdraw assets:
    - `assets = shares * marginfi_assets_before / total_shares`

## SDK Integration Added Here

`sdk/core/src/strategy.ts` now includes:

- `createMarginfiMsolStrategy(...)`
- `previewMarginfiMsolDepositShares(...)`
- `previewMarginfiMsolWithdrawAssets(...)`
- constants:
  - `MSOL_MINT_DEVNET = mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So`
  - `MARGINFI_GROUP_DEVNET = J9VZnaMGTELGCPsqMxk8aoyEGYcVzhorj48HvtDdEtc8`

These helpers keep SVS-6 native SOL streaming logic intact while exposing a tested Marginfi mSOL route template in SDK/CLI workflows.

## Devnet Proof (SVS-6 Program)

Validation command:

```bash
solana program show GuBDfEKriv9ZYMfneTFHQ9zqc3W79fF78YfAL79mBJVb --url devnet
```

Observed result on 2026-03-19:

- Program ID: `GuBDfEKriv9ZYMfneTFHQ9zqc3W79fF78YfAL79mBJVb`
- Owner: `BPFLoaderUpgradeab1e11111111111111111111111`
- Authority: `3WJxpvbexvubm5p8rLVdAXEuzQ725VPxUbALvdeXZiXb`
- Last deployed slot: `449515708` (`2026-03-19T07:59:41Z` from `solana block-time`)

## Follow-up for Upstream PR

- Keep this note as migration rationale from Bear Vault MVP.
- Include SDK strategy tests proving share/withdraw math parity with the reference pattern.
- If on-chain Marginfi CPI is added later, preserve these formulas as preview ground truth.
