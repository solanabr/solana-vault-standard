# SVS-7 Demo Plan (Ranger Submission)

## Goal
Show end-to-end SVS-7 Native SOL vault behavior with both balance models and dual interfaces (`*_sol`, `*_wsol`).

## Script (3-4 minutes)
1. Intro (20s)
- Explain SVS-7: native SOL UX with internal wSOL accounting.
- Highlight dual interface and Live vs Stored balance model.

2. Initialize vaults (40s)
- Create `Live` vault and `Stored` vault.
- Show PDA derivations (`sol_vault`, `shares`, `wsol_vault ATA`).

3. Live flow (60s)
- `deposit_sol` from wallet.
- Show minted shares and increased `wsol_vault.amount`.
- `withdraw_sol` and show native SOL returned (single tx unwrap path).

4. Stored flow + sync (60s)
- `deposit_sol` into Stored vault.
- Donate extra lamports directly to `wsol_vault` + `sync_native`.
- Show `vault.total_assets` unchanged before `sync()`.
- Call `sync()` and show tracked assets update.

5. Protocol path (`*_wsol`) (40s)
- `deposit_wsol` and `withdraw_wsol` from pre-wrapped account.
- Compare with SOL path and mention composability for CPI/protocol use.

6. Wrap-up (20s)
- Summarize security properties: vault-favoring rounding, slippage guards, pause/admin controls.
- Link to test file and build logs.

## Recording Checklist
- Terminal split: code/test logs + account state reads.
- Show exact commands run:
  - `anchor build -p svs-7`
  - `anchor test -- tests/svs-7.ts`
- Keep transaction signatures visible for reproducibility.
