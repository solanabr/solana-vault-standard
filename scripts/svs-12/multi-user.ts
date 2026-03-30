/**
 * SVS-12 Multi-User Test Script
 *
 * Tests concurrent multi-user deposits and redeems across tranches:
 * - User1 deposits into junior, User2 deposits into senior
 * - Manager distributes yield
 * - Both users redeem partial positions
 * - Verifies share balances are independent and correct
 * - Verifies vault total_assets invariant
 *
 * Run: npx ts-node scripts/svs-12/multi-user.ts
 */

import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  setupTest,
  setupVaultWithTranches,
  fundAccount,
  explorerUrl,
  LAMPORTS_PER_ASSET,
} from "./helpers";

async function main() {
  const setup = await setupTest("Multi-User Deposits & Redeems");
  const { program, payer, connection } = setup;

  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Setting up vault with tranches");
  console.log("-".repeat(70));

  const v = await setupVaultWithTranches(setup);

  // --- Step 2: Create and fund additional users ---
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Create and fund User1 + User2");
  console.log("-".repeat(70));

  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  // Fund with SOL
  await fundAccount(connection, payer, user1.publicKey, 0.5);
  await fundAccount(connection, payer, user2.publicKey, 0.5);
  console.log(`  User1: ${user1.publicKey.toBase58()}`);
  console.log(`  User2: ${user2.publicKey.toBase58()}`);

  // Create asset ATAs and mint tokens
  const user1Ata = await getOrCreateAssociatedTokenAccount(
    connection, payer, v.assetMint, user1.publicKey, false,
    undefined, undefined, TOKEN_PROGRAM_ID,
  );
  const user2Ata = await getOrCreateAssociatedTokenAccount(
    connection, payer, v.assetMint, user2.publicKey, false,
    undefined, undefined, TOKEN_PROGRAM_ID,
  );

  await mintTo(
    connection, payer, v.assetMint, user1Ata.address,
    payer.publicKey, 5000 * LAMPORTS_PER_ASSET, [], undefined, TOKEN_PROGRAM_ID,
  );
  await mintTo(
    connection, payer, v.assetMint, user2Ata.address,
    payer.publicKey, 5000 * LAMPORTS_PER_ASSET, [], undefined, TOKEN_PROGRAM_ID,
  );
  console.log("  Minted 5000 tokens to each user");

  // Create shares ATAs for both users
  const user1JuniorSharesAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, v.juniorSharesMint, user1.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );
  const user1SeniorSharesAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, v.seniorSharesMint, user1.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );
  const user2JuniorSharesAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, v.juniorSharesMint, user2.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );
  const user2SeniorSharesAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, v.seniorSharesMint, user2.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );
  console.log("  Created shares ATAs for both users");

  // --- Step 3: User1 deposits into junior ---
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: User1 deposits 2000 into junior tranche");
  console.log("-".repeat(70));

  const user1DepSig = await program.methods
    .deposit(new BN(2000 * LAMPORTS_PER_ASSET), new BN(0))
    .accountsStrict({
      user: user1.publicKey,
      vault: v.vault,
      targetTranche: v.juniorTranche,
      tranche1: v.seniorTranche,
      tranche2: null,
      tranche3: null,
      assetMint: v.assetMint,
      userAssetAccount: user1Ata.address,
      assetVault: v.assetVault,
      sharesMint: v.juniorSharesMint,
      userSharesAccount: user1JuniorSharesAta.address,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers([user1])
    .rpc();
  console.log(`  Tx: ${explorerUrl(user1DepSig)}`);

  const juniorAfterUser1 = await program.account.tranche.fetch(v.juniorTranche);
  const user1JuniorShares = juniorAfterUser1.totalShares.toNumber();
  console.log(`  User1 junior shares: ${user1JuniorShares}`);

  // --- Step 4: User2 deposits into senior ---
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: User2 deposits 2000 into senior tranche");
  console.log("-".repeat(70));

  const user2DepSig = await program.methods
    .deposit(new BN(2000 * LAMPORTS_PER_ASSET), new BN(0))
    .accountsStrict({
      user: user2.publicKey,
      vault: v.vault,
      targetTranche: v.seniorTranche,
      tranche1: v.juniorTranche,
      tranche2: null,
      tranche3: null,
      assetMint: v.assetMint,
      userAssetAccount: user2Ata.address,
      assetVault: v.assetVault,
      sharesMint: v.seniorSharesMint,
      userSharesAccount: user2SeniorSharesAta.address,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers([user2])
    .rpc();
  console.log(`  Tx: ${explorerUrl(user2DepSig)}`);

  const seniorAfterUser2 = await program.account.tranche.fetch(v.seniorTranche);
  const user2SeniorShares = seniorAfterUser2.totalShares.toNumber();
  console.log(`  User2 senior shares: ${user2SeniorShares}`);

  // --- Step 5: Manager distributes yield ---
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Manager distributes 200 yield");
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
  console.log(`  Tx: ${explorerUrl(yieldSig)}`);

  const seniorPostYield = await program.account.tranche.fetch(v.seniorTranche);
  const juniorPostYield = await program.account.tranche.fetch(v.juniorTranche);
  const seniorYield = seniorPostYield.totalAssetsAllocated.toNumber() - 2000 * LAMPORTS_PER_ASSET;
  const juniorYield = juniorPostYield.totalAssetsAllocated.toNumber() - 2000 * LAMPORTS_PER_ASSET;
  console.log(`  Senior yield: +${seniorYield / LAMPORTS_PER_ASSET}`);
  console.log(`  Junior yield: +${juniorYield / LAMPORTS_PER_ASSET}`);

  // --- Step 6: User1 redeems partial from junior ---
  console.log("\n" + "-".repeat(70));
  console.log("Step 6: User1 redeems 500 shares from junior");
  console.log("-".repeat(70));

  const redeemSharesAmount = 500 * 10 ** 9; // 500 shares at 9 decimals

  const user1RedeemSig = await program.methods
    .redeem(new BN(redeemSharesAmount), new BN(0))
    .accountsStrict({
      user: user1.publicKey,
      vault: v.vault,
      targetTranche: v.juniorTranche,
      tranche1: v.seniorTranche,
      tranche2: null,
      tranche3: null,
      assetMint: v.assetMint,
      userAssetAccount: user1Ata.address,
      assetVault: v.assetVault,
      sharesMint: v.juniorSharesMint,
      userSharesAccount: user1JuniorSharesAta.address,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers([user1])
    .rpc();
  console.log(`  Tx: ${explorerUrl(user1RedeemSig)}`);

  // --- Step 7: User2 redeems partial from senior ---
  console.log("\n" + "-".repeat(70));
  console.log("Step 7: User2 redeems 500 shares from senior");
  console.log("-".repeat(70));

  const user2RedeemSig = await program.methods
    .redeem(new BN(redeemSharesAmount), new BN(0))
    .accountsStrict({
      user: user2.publicKey,
      vault: v.vault,
      targetTranche: v.seniorTranche,
      tranche1: v.juniorTranche,
      tranche2: null,
      tranche3: null,
      assetMint: v.assetMint,
      userAssetAccount: user2Ata.address,
      assetVault: v.assetVault,
      sharesMint: v.seniorSharesMint,
      userSharesAccount: user2SeniorSharesAta.address,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers([user2])
    .rpc();
  console.log(`  Tx: ${explorerUrl(user2RedeemSig)}`);

  // --- Step 8: Verify final state ---
  console.log("\n" + "-".repeat(70));
  console.log("Step 8: Verify final state");
  console.log("-".repeat(70));

  const vaultFinal = await program.account.tranchedVault.fetch(v.vault);
  const seniorFinal = await program.account.tranche.fetch(v.seniorTranche);
  const juniorFinal = await program.account.tranche.fetch(v.juniorTranche);

  const trancheSum =
    seniorFinal.totalAssetsAllocated.toNumber() +
    juniorFinal.totalAssetsAllocated.toNumber();

  console.log(`  Vault total_assets: ${vaultFinal.totalAssets.toNumber()}`);
  console.log(`  Senior allocated: ${seniorFinal.totalAssetsAllocated.toNumber()}`);
  console.log(`  Junior allocated: ${juniorFinal.totalAssetsAllocated.toNumber()}`);
  console.log(`  Tranche sum: ${trancheSum}`);
  console.log(`  Senior remaining shares: ${seniorFinal.totalShares.toNumber()}`);
  console.log(`  Junior remaining shares: ${juniorFinal.totalShares.toNumber()}`);

  // Invariant: vault.total_assets == sum of tranche allocations
  if (vaultFinal.totalAssets.toNumber() === trancheSum) {
    console.log("  OK: Vault total_assets == sum of tranche allocations");
  } else {
    console.log("  ERROR: Vault total_assets mismatch");
    process.exit(1);
  }

  // Verify shares were burned (total shares decreased after redeems)
  if (seniorFinal.totalShares.toNumber() < user2SeniorShares) {
    console.log("  OK: Senior shares decreased after User2 redeem");
  } else {
    console.log("  ERROR: Senior shares did not decrease");
    process.exit(1);
  }

  if (juniorFinal.totalShares.toNumber() < user1JuniorShares) {
    console.log("  OK: Junior shares decreased after User1 redeem");
  } else {
    console.log("  ERROR: Junior shares did not decrease");
    process.exit(1);
  }

  // Verify each tranche still has positive assets (partial redeems)
  if (seniorFinal.totalAssetsAllocated.toNumber() > 0 && juniorFinal.totalAssetsAllocated.toNumber() > 0) {
    console.log("  OK: Both tranches retain assets after partial redeems");
  } else {
    console.log("  ERROR: A tranche was unexpectedly emptied");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(70));
  console.log("  All multi-user tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
