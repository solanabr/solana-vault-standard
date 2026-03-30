/**
 * SVS-10 View Functions Test
 *
 * Tests read-only / simulated view calls:
 * - pendingDepositRequest
 * - pendingRedeemRequest (if available)
 * - Vault state queries
 *
 * Run: npx ts-node scripts/svs-10/view-functions.ts
 */

import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  setupTest,
  createAndInitializeVault,
  explorerUrl,
  getDepositRequestAddress,
} from "./helpers";

async function main() {
  const setup = await setupTest("View Functions");
  const { payer, program, programId } = setup;

  // Setup: initialize vault
  const ctx = await createAndInitializeVault(setup);

  // ── Create a deposit request to query ───────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Creating deposit request for view queries");
  console.log("-".repeat(70));

  const viewDepAmount = new BN(200_000_000);
  const [depositRequest] = getDepositRequestAddress(programId, ctx.vault, payer.publicKey);

  const reqSig = await program.methods
    .requestDeposit(viewDepAmount, payer.publicKey)
    .accounts({
      user: payer.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      userAssetAccount: ctx.userAta,
      assetVault: ctx.assetVault,
      depositRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`  Request: ${explorerUrl(reqSig)}`);

  // ── Query pending deposit via simulate ──────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Querying pendingDepositRequest via simulate");
  console.log("-".repeat(70));

  const pendingDepSim = await program.methods
    .pendingDepositRequest()
    .accounts({ vault: ctx.vault })
    .remainingAccounts([{ pubkey: depositRequest, isWritable: false, isSigner: false }])
    .simulate();

  console.log(`  pendingDepositRequest: simulated OK (return data present: ${!!pendingDepSim.raw})`);

  // ── Query vault state ───────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Querying vault state");
  console.log("-".repeat(70));

  const vaultState = await (program.account as any).asyncVault.fetch(ctx.vault);
  console.log(`  Authority:    ${vaultState.authority.toBase58()}`);
  console.log(`  Operator:     ${vaultState.operator.toBase58()}`);
  console.log(`  Total assets: ${vaultState.totalAssets.toString()}`);
  console.log(`  Total shares: ${vaultState.totalShares.toString()}`);
  console.log(`  Paused:       ${vaultState.paused}`);

  // ── Cleanup: cancel the view test deposit ───────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Cleanup: cancelling test deposit");
  console.log("-".repeat(70));

  const cancelSig = await program.methods
    .cancelDeposit()
    .accounts({
      user: payer.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      userAssetAccount: ctx.userAta,
      assetVault: ctx.assetVault,
      depositRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  console.log(`  Cancelled: ${explorerUrl(cancelSig)}`);

  console.log("\n" + "=".repeat(70));
  console.log("  All view function tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
