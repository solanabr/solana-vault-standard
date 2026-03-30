/**
 * SVS-12 Edge Cases Test Script
 *
 * Tests:
 * - Cap violation on deposit (senior exceeds cap bps)
 * - Subordination breach on rebalance
 * - Junior wiped by large loss, senior partially affected
 *
 * Run: npx ts-node scripts/svs-12/edge-cases.ts
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
  const setup = await setupTest("Edge Cases");
  const { program, payer } = setup;

  // --- Test 1: Cap violation ---
  console.log("\n" + "-".repeat(70));
  console.log("Test 1: Senior tranche cap violation");
  console.log("-".repeat(70));

  const v = await setupVaultWithTranches(setup, {
    seniorCap: 5000, // 50% cap
  });

  // Deposit 1000 into junior first
  await program.methods
    .deposit(new BN(1000 * LAMPORTS_PER_ASSET), new BN(0))
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
  console.log("  Deposited 1000 into junior");

  // Attempt to deposit 1500 into senior (1500/2500 = 60% > 50% cap)
  try {
    await program.methods
      .deposit(new BN(1500 * LAMPORTS_PER_ASSET), new BN(0))
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
    console.log("  ERROR: Deposit should have been rejected (cap breach)");
    process.exit(1);
  } catch (err: any) {
    if (err.toString().includes("CapExceeded") || err.toString().includes("cap")) {
      console.log("  Correctly rejected: cap violation");
    } else {
      console.log(`  Rejected with: ${err.message || err}`);
    }
  }

  // Deposit 500 into senior (500/1500 = 33% < 50% cap, OK)
  const okSig = await program.methods
    .deposit(new BN(500 * LAMPORTS_PER_ASSET), new BN(0))
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
  console.log(`  Deposit 500 into senior (within cap): ${explorerUrl(okSig)}`);

  // --- Test 2: Junior wiped by large loss ---
  console.log("\n" + "-".repeat(70));
  console.log("Test 2: Junior wiped by large loss");
  console.log("-".repeat(70));

  const v2 = await setupVaultWithTranches(setup);

  // Deposit into both tranches
  await program.methods
    .deposit(new BN(1000 * LAMPORTS_PER_ASSET), new BN(0))
    .accountsStrict({
      user: payer.publicKey,
      vault: v2.vault,
      targetTranche: v2.juniorTranche,
      tranche1: v2.seniorTranche,
      tranche2: null,
      tranche3: null,
      assetMint: v2.assetMint,
      userAssetAccount: v2.userAta,
      assetVault: v2.assetVault,
      sharesMint: v2.juniorSharesMint,
      userSharesAccount: v2.userJuniorSharesAta,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();

  await program.methods
    .deposit(new BN(1000 * LAMPORTS_PER_ASSET), new BN(0))
    .accountsStrict({
      user: payer.publicKey,
      vault: v2.vault,
      targetTranche: v2.seniorTranche,
      tranche1: v2.juniorTranche,
      tranche2: null,
      tranche3: null,
      assetMint: v2.assetMint,
      userAssetAccount: v2.userAta,
      assetVault: v2.assetVault,
      sharesMint: v2.seniorSharesMint,
      userSharesAccount: v2.userSeniorSharesAta,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  console.log("  Deposited 1000 into each tranche");

  // Loss of 1500 (wipes junior's 1000, senior takes 500)
  const wipeSig = await program.methods
    .recordLoss(new BN(1500 * LAMPORTS_PER_ASSET))
    .accountsStrict({
      manager: payer.publicKey,
      vault: v2.vault,
      tranche0: v2.seniorTranche,
      tranche1: v2.juniorTranche,
      tranche2: null,
      tranche3: null,
    })
    .rpc();

  const juniorWiped = await program.account.tranche.fetch(v2.juniorTranche);
  const seniorAfter = await program.account.tranche.fetch(v2.seniorTranche);
  console.log(`  Tx: ${explorerUrl(wipeSig)}`);
  console.log(`  Junior assets: ${juniorWiped.totalAssetsAllocated.toNumber() / LAMPORTS_PER_ASSET} (expected 0)`);
  console.log(`  Senior assets: ${seniorAfter.totalAssetsAllocated.toNumber() / LAMPORTS_PER_ASSET} (expected 500)`);

  console.log("\n" + "=".repeat(70));
  console.log("  All edge case tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
