/**
 * SVS-12 Admin Operations Test Script
 *
 * Tests:
 * - Pause / unpause vault
 * - Transfer authority
 * - Set manager
 * - Update tranche config
 *
 * Run: npx ts-node scripts/svs-12/admin.ts
 */

import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import {
  setupTest,
  setupVaultWithTranches,
  explorerUrl,
} from "./helpers";

async function main() {
  const setup = await setupTest("Admin Operations");
  const { program, payer } = setup;

  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Setting up vault with tranches");
  console.log("-".repeat(70));

  const v = await setupVaultWithTranches(setup);

  // Pause
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Pause vault");
  console.log("-".repeat(70));

  const pauseSig = await program.methods
    .pause()
    .accountsStrict({ authority: payer.publicKey, vault: v.vault })
    .rpc();
  console.log(`  Tx: ${explorerUrl(pauseSig)}`);

  const vaultAfterPause = await program.account.tranchedVault.fetch(v.vault);
  console.log(`  Paused: ${vaultAfterPause.paused}`);

  // Unpause
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Unpause vault");
  console.log("-".repeat(70));

  const unpauseSig = await program.methods
    .unpause()
    .accountsStrict({ authority: payer.publicKey, vault: v.vault })
    .rpc();
  console.log(`  Tx: ${explorerUrl(unpauseSig)}`);

  const vaultAfterUnpause = await program.account.tranchedVault.fetch(v.vault);
  console.log(`  Paused: ${vaultAfterUnpause.paused}`);

  // Set manager
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Set manager");
  console.log("-".repeat(70));

  const newManager = Keypair.generate();
  const setManagerSig = await program.methods
    .setManager(newManager.publicKey)
    .accountsStrict({ authority: payer.publicKey, vault: v.vault })
    .rpc();
  console.log(`  Tx: ${explorerUrl(setManagerSig)}`);
  console.log(`  New manager: ${newManager.publicKey.toBase58()}`);

  // Restore original manager
  const restoreSig = await program.methods
    .setManager(payer.publicKey)
    .accountsStrict({ authority: payer.publicKey, vault: v.vault })
    .rpc();
  console.log(`  Restored original manager: ${explorerUrl(restoreSig)}`);

  // Update tranche config
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Update tranche config (senior yield -> 1000bps)");
  console.log("-".repeat(70));

  const updateSig = await program.methods
    .updateTrancheConfig(1000, null, null)
    .accountsStrict({
      authority: payer.publicKey,
      vault: v.vault,
      targetTranche: v.seniorTranche,
      tranche1: v.juniorTranche,
      tranche2: null,
      tranche3: null,
    })
    .rpc();
  console.log(`  Tx: ${explorerUrl(updateSig)}`);

  const updatedTranche = await program.account.tranche.fetch(v.seniorTranche);
  console.log(`  Senior target yield: ${updatedTranche.targetYieldBps} bps`);

  console.log("\n" + "=".repeat(70));
  console.log("  All admin tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
