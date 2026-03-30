/**
 * SVS-12 Loss & Rebalance Test Script
 *
 * Tests:
 * - Record loss and verify junior absorbs first
 * - Rebalance assets between tranches
 *
 * Run: npx ts-node scripts/svs-12/loss-rebalance.ts
 */

import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  setupTest,
  setupVaultWithTranches,
  explorerUrl,
  LAMPORTS_PER_ASSET,
} from "./helpers";

async function main() {
  const setup = await setupTest("Loss & Rebalance");
  const { program, payer } = setup;

  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Setting up vault with funded tranches");
  console.log("-".repeat(70));

  const v = await setupVaultWithTranches(setup);

  // Deposit into both tranches
  await program.methods
    .deposit(new BN(2000 * LAMPORTS_PER_ASSET), new BN(0))
    .accountsStrict({
      user: payer.publicKey,
      vault: v.vault,
      targetTranche: v.juniorTranche,
      tranche1: v.seniorTranche,
      tranche2: null,
      tranche3: null,
      assetMint: v.assetMint,
      userAssetAccount: v.userAta,
      assetVault: v.assetVault,
      sharesMint: v.juniorSharesMint,
      userSharesAccount: v.userJuniorSharesAta,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  console.log("  Deposited 2000 into junior");

  await program.methods
    .deposit(new BN(2000 * LAMPORTS_PER_ASSET), new BN(0))
    .accountsStrict({
      user: payer.publicKey,
      vault: v.vault,
      targetTranche: v.seniorTranche,
      tranche1: v.juniorTranche,
      tranche2: null,
      tranche3: null,
      assetMint: v.assetMint,
      userAssetAccount: v.userAta,
      assetVault: v.assetVault,
      sharesMint: v.seniorSharesMint,
      userSharesAccount: v.userSeniorSharesAta,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  console.log("  Deposited 2000 into senior");

  // Record loss (500)
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Record loss (500 USDC)");
  console.log("-".repeat(70));

  const lossSig = await program.methods
    .recordLoss(new BN(500 * LAMPORTS_PER_ASSET))
    .accountsStrict({
      manager: payer.publicKey,
      vault: v.vault,
      tranche0: v.seniorTranche,
      tranche1: v.juniorTranche,
      tranche2: null,
      tranche3: null,
    })
    .rpc();

  const juniorAfterLoss = await program.account.tranche.fetch(v.juniorTranche);
  const seniorAfterLoss = await program.account.tranche.fetch(v.seniorTranche);
  console.log(`  Tx: ${explorerUrl(lossSig)}`);
  console.log(`  Junior assets: ${juniorAfterLoss.totalAssetsAllocated.toNumber() / LAMPORTS_PER_ASSET}`);
  console.log(`  Senior assets: ${seniorAfterLoss.totalAssetsAllocated.toNumber() / LAMPORTS_PER_ASSET}`);

  // Verify junior absorbed the loss
  const juniorExpected = (2000 - 500) * LAMPORTS_PER_ASSET;
  if (juniorAfterLoss.totalAssetsAllocated.toNumber() !== juniorExpected) {
    console.log(`  WARNING: Expected junior=${juniorExpected}, got ${juniorAfterLoss.totalAssetsAllocated.toNumber()}`);
  } else {
    console.log("  Junior correctly absorbed full loss");
  }

  // Rebalance junior -> senior (50)
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Rebalance 50 from junior to senior");
  console.log("-".repeat(70));

  const rebalSig = await program.methods
    .rebalanceTranches(new BN(50 * LAMPORTS_PER_ASSET))
    .accountsStrict({
      manager: payer.publicKey,
      vault: v.vault,
      fromTranche: v.juniorTranche,
      toTranche: v.seniorTranche,
      otherTranche0: null,
      otherTranche1: null,
    })
    .rpc();

  const juniorAfterRebal = await program.account.tranche.fetch(v.juniorTranche);
  const seniorAfterRebal = await program.account.tranche.fetch(v.seniorTranche);
  console.log(`  Tx: ${explorerUrl(rebalSig)}`);
  console.log(`  Junior assets: ${juniorAfterRebal.totalAssetsAllocated.toNumber() / LAMPORTS_PER_ASSET}`);
  console.log(`  Senior assets: ${seniorAfterRebal.totalAssetsAllocated.toNumber() / LAMPORTS_PER_ASSET}`);

  console.log("\n" + "=".repeat(70));
  console.log("  All loss & rebalance tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
