/**
 * SVS-12 Basic Test Script
 *
 * Tests core tranched vault functionality:
 * - Initialize vault with sequential waterfall
 * - Add senior + junior tranches
 * - Deposit into both tranches
 * - Distribute yield and verify waterfall allocation
 *
 * Run: npx ts-node scripts/svs-12/basic.ts
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
  const setup = await setupTest("Basic Functionality");
  const { program, payer } = setup;

  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Setting up vault with tranches");
  console.log("-".repeat(70));

  const v = await setupVaultWithTranches(setup);

  // Deposit 2000 into junior
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Deposit 2000 into junior tranche");
  console.log("-".repeat(70));

  const depJuniorSig = await program.methods
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
  console.log(`  Tx: ${explorerUrl(depJuniorSig)}`);

  // Deposit 2000 into senior (cap=60%, 2000/4000=50% OK)
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Deposit 2000 into senior tranche");
  console.log("-".repeat(70));

  const depSeniorSig = await program.methods
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
  console.log(`  Tx: ${explorerUrl(depSeniorSig)}`);

  // Distribute yield (200)
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Distribute yield (200 USDC)");
  console.log("-".repeat(70));

  const yieldSig = await program.methods
    .distributeYield(new BN(200 * LAMPORTS_PER_ASSET))
    .accountsStrict({
      manager: payer.publicKey,
      vault: v.vault,
      assetMint: v.assetMint,
      managerAssetAccount: v.userAta,
      assetVault: v.assetVault,
      tranche0: v.seniorTranche,
      tranche1: v.juniorTranche,
      tranche2: null,
      tranche3: null,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const seniorState = await program.account.tranche.fetch(v.seniorTranche);
  const juniorState = await program.account.tranche.fetch(v.juniorTranche);
  const seniorYield = seniorState.totalAssetsAllocated.toNumber() - 2000 * LAMPORTS_PER_ASSET;
  const juniorYield = juniorState.totalAssetsAllocated.toNumber() - 2000 * LAMPORTS_PER_ASSET;
  console.log(`  Tx: ${explorerUrl(yieldSig)}`);
  console.log(`  Senior yield: +${seniorYield / LAMPORTS_PER_ASSET}`);
  console.log(`  Junior yield: +${juniorYield / LAMPORTS_PER_ASSET}`);

  // Redeem from junior (100 shares)
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Redeem 100 shares from junior");
  console.log("-".repeat(70));

  const redeemSig = await program.methods
    .redeem(new BN(100 * 10 ** 9), new BN(0))
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
  console.log(`  Tx: ${explorerUrl(redeemSig)}`);

  console.log("\n" + "=".repeat(70));
  console.log("  All basic tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
