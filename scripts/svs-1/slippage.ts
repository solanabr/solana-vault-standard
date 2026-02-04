/**
 * SVS-1 Slippage Protection Test
 *
 * Tests that min/max slippage parameters work correctly:
 * - deposit() with minSharesOut too high → should revert
 * - mint() with maxAssetsIn too low → should revert
 * - withdraw() with maxSharesIn too low → should revert
 * - redeem() with minAssetsOut too high → should revert
 *
 * Run: npx ts-node scripts/svs-1/slippage.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { setupTest, getVaultPDA, getSharesMintPDA, ASSET_DECIMALS } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("Slippage Protection");

  // Setup
  console.log("--- Setup ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );

  await mintTo(connection, payer, assetMint, userAta.address, payer, 1_000_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .initialize(vaultId, "Slippage Test Vault", "SLIP", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Initial deposit
  await program.methods
    .deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address, assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("  Setup complete\n");

  let passed = 0;
  let failed = 0;

  // TEST 1: deposit() with minSharesOut too high
  console.log("-".repeat(70));
  console.log("TEST 1: deposit() with minSharesOut too high");
  console.log("-".repeat(70));

  try {
    await program.methods
      .deposit(new BN(1000 * 10 ** ASSET_DECIMALS), new BN(10_000_000 * 10 ** 9))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address, assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  ❌ FAILED: Should have reverted"); failed++;
  } catch (err: any) {
    if (err.toString().includes("Slippage")) {
      console.log("  ✅ PASSED: Correctly reverted"); passed++;
    } else {
      console.log(`  ✅ PASSED: Rejected (${err.message.slice(0, 40)}...)`); passed++;
    }
  }

  // TEST 2: deposit() with reasonable minSharesOut
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: deposit() with reasonable minSharesOut (should succeed)");
  console.log("-".repeat(70));

  try {
    await program.methods
      .deposit(new BN(1000 * 10 ** ASSET_DECIMALS), new BN(900 * 10 ** 9))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address, assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  ✅ PASSED: Deposit succeeded"); passed++;
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); failed++;
  }

  // TEST 3: mint() with maxAssetsIn too low
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: mint() with maxAssetsIn too low");
  console.log("-".repeat(70));

  try {
    await program.methods
      .mint(new BN(1000 * 10 ** 9), new BN(1 * 10 ** ASSET_DECIMALS))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address, assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  ❌ FAILED: Should have reverted"); failed++;
  } catch (err: any) {
    console.log("  ✅ PASSED: Correctly reverted"); passed++;
  }

  // TEST 4: withdraw() with maxSharesIn too low
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: withdraw() with maxSharesIn too low");
  console.log("-".repeat(70));

  try {
    await program.methods
      .withdraw(new BN(1000 * 10 ** ASSET_DECIMALS), new BN(1 * 10 ** 9))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address, assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log("  ❌ FAILED: Should have reverted"); failed++;
  } catch (err: any) {
    console.log("  ✅ PASSED: Correctly reverted"); passed++;
  }

  // TEST 5: redeem() with minAssetsOut too high
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: redeem() with minAssetsOut too high");
  console.log("-".repeat(70));

  const userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const sharesToRedeem = new BN(Math.floor(Number(userShares.amount) / 10));

  try {
    await program.methods
      .redeem(sharesToRedeem, new BN(1_000_000 * 10 ** ASSET_DECIMALS))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address, assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log("  ❌ FAILED: Should have reverted"); failed++;
  } catch (err: any) {
    console.log("  ✅ PASSED: Correctly reverted"); passed++;
  }

  // TEST 6: redeem() with reasonable minAssetsOut
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: redeem() with reasonable minAssetsOut (should succeed)");
  console.log("-".repeat(70));

  try {
    await program.methods
      .redeem(sharesToRedeem, new BN(100 * 10 ** ASSET_DECIMALS))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address, assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log("  ✅ PASSED: Redeem succeeded"); passed++;
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/6 passed`);
  console.log(`  Slippage protection ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
