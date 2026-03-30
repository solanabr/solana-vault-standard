/**
 * SVS-10 Operator Delegation Test
 *
 * Tests operator management:
 * - Set operator with granular permissions (approve all)
 * - Revoke operator permissions
 * - Set vault operator (admin-level)
 * - Restore vault operator
 *
 * Run: npx ts-node scripts/svs-10/operator-delegation.ts
 */

import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  setupTest,
  createAndInitializeVault,
  explorerUrl,
  getOperatorApprovalAddress,
} from "./helpers";

async function main() {
  const setup = await setupTest("Operator Delegation");
  const { payer, program, programId } = setup;

  const results: { step: string; sig: string }[] = [];

  // Setup: initialize vault
  const ctx = await createAndInitializeVault(setup);

  // ── Set operator (granular permissions) ─────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Set operator with granular permissions");
  console.log("-".repeat(70));

  const operatorKp = Keypair.generate();
  const [operatorApproval] = getOperatorApprovalAddress(
    programId, ctx.vault, payer.publicKey, operatorKp.publicKey,
  );

  const setOpSig = await program.methods
    .setOperator(operatorKp.publicKey, true, true, true)
    .accounts({
      owner: payer.publicKey,
      vault: ctx.vault,
      operatorApproval,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Set operator (approve all)", sig: setOpSig });
  console.log(`  Operator: ${operatorKp.publicKey.toBase58()}`);
  console.log(`  OK: ${explorerUrl(setOpSig)}`);

  // ── Revoke operator ─────────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Revoke operator permissions");
  console.log("-".repeat(70));

  const revokeOpSig = await program.methods
    .setOperator(operatorKp.publicKey, false, false, false)
    .accounts({
      owner: payer.publicKey,
      vault: ctx.vault,
      operatorApproval,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Set operator (revoke)", sig: revokeOpSig });
  console.log(`  Revoked: ${explorerUrl(revokeOpSig)}`);

  // ── Set vault operator (admin) ──────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Set vault operator (admin-level)");
  console.log("-".repeat(70));

  const newOperatorKp = Keypair.generate();

  const setVaultOpSig = await program.methods
    .setVaultOperator(newOperatorKp.publicKey)
    .accounts({ authority: payer.publicKey, vault: ctx.vault })
    .rpc();

  results.push({ step: "Set vault operator", sig: setVaultOpSig });
  console.log(`  New operator: ${newOperatorKp.publicKey.toBase58()}`);
  console.log(`  OK: ${explorerUrl(setVaultOpSig)}`);

  // ── Restore original vault operator ─────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Restore original vault operator");
  console.log("-".repeat(70));

  const restoreOpSig = await program.methods
    .setVaultOperator(payer.publicKey)
    .accounts({ authority: payer.publicKey, vault: ctx.vault })
    .rpc();

  results.push({ step: "Restore vault operator", sig: restoreOpSig });
  console.log(`  Restored: ${explorerUrl(restoreOpSig)}`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));
  console.log();

  for (const r of results) {
    console.log(`  ${r.step.padEnd(30)} ${explorerUrl(r.sig)}`);
  }

  console.log();
  console.log("  All operator delegation tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
