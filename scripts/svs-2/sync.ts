/**
 * SVS-2 Sync Function Test
 *
 * Tests the sync() instruction that updates stored total_assets:
 * 1. Basic sync: deposit → donate → verify discrepancy → sync → verify match
 * 2. Sync after yield simulation
 * 3. Sync idempotency (calling twice has no further effect)
 *
 * Run: npx ts-node scripts/svs-2/sync.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { setupTest, getVaultPDA, getSharesMintPDA, syncVault, ASSET_DECIMALS } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("Sync Function");

  let passed = 0;
  let failed = 0;

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  await mintTo(connection, payer, assetMint, userAta.address, payer, 10_000_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .initialize(vaultId, "Sync Test Vault", "SYNC2", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  await program.methods
    .deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  // ============================================================================
  // TEST 1: Basic sync after external transfer
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 1: Basic Sync After External Transfer");
  console.log("=".repeat(70));

  let vaultState = await program.account.vault.fetch(vault);
  const storedBefore = vaultState.totalAssets.toNumber();
  console.log(`\n  Stored total_assets: ${storedBefore / 10 ** ASSET_DECIMALS}`);

  // Simulate yield via direct transfer
  const yieldAmount = 5000 * 10 ** ASSET_DECIMALS;
  await transfer(connection, payer, userAta.address, assetVault, payer, yieldAmount, [], undefined, TOKEN_PROGRAM_ID);

  vaultState = await program.account.vault.fetch(vault);
  const vaultBalance = await getAccount(connection, assetVault);

  console.log(`  After transfer:`);
  console.log(`    Stored total_assets: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`    Actual balance:      ${Number(vaultBalance.amount) / 10 ** ASSET_DECIMALS}`);

  // Stored should NOT have changed
  if (vaultState.totalAssets.toNumber() === storedBefore) {
    console.log("  ✅ Stored balance unchanged after direct transfer");
  } else {
    console.log("  ❌ Stored balance changed without sync!");
    failed++;
  }

  // Call sync
  await syncVault(program, payer, vault, assetVault);

  vaultState = await program.account.vault.fetch(vault);
  console.log(`  After sync:`);
  console.log(`    Stored total_assets: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  if (vaultState.totalAssets.toNumber() === Number(vaultBalance.amount)) {
    console.log("  ✅ PASSED: Sync updated stored balance to match actual");
    passed++;
  } else {
    console.log("  ❌ FAILED: Stored balance doesn't match actual");
    failed++;
  }

  // ============================================================================
  // TEST 2: Sync after yield (share price should increase)
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 2: Sync After Yield (Share Price Increase)");
  console.log("=".repeat(70));

  const totalAssetsBefore = vaultState.totalAssets.toNumber();

  // Another yield
  const yield2 = 2000 * 10 ** ASSET_DECIMALS;
  await transfer(connection, payer, userAta.address, assetVault, payer, yield2, [], undefined, TOKEN_PROGRAM_ID);

  await syncVault(program, payer, vault, assetVault);

  vaultState = await program.account.vault.fetch(vault);
  const totalAssetsAfter = vaultState.totalAssets.toNumber();

  console.log(`\n  total_assets before: ${totalAssetsBefore / 10 ** ASSET_DECIMALS}`);
  console.log(`  total_assets after:  ${totalAssetsAfter / 10 ** ASSET_DECIMALS}`);
  console.log(`  Increase:            ${(totalAssetsAfter - totalAssetsBefore) / 10 ** ASSET_DECIMALS}`);

  if (totalAssetsAfter > totalAssetsBefore) {
    console.log("  ✅ PASSED: Share price increased after sync");
    passed++;
  } else {
    console.log("  ❌ FAILED");
    failed++;
  }

  // ============================================================================
  // TEST 3: Sync idempotency
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 3: Sync Idempotency");
  console.log("=".repeat(70));

  vaultState = await program.account.vault.fetch(vault);
  const beforeSecondSync = vaultState.totalAssets.toNumber();

  await syncVault(program, payer, vault, assetVault);

  vaultState = await program.account.vault.fetch(vault);
  const afterSecondSync = vaultState.totalAssets.toNumber();

  console.log(`\n  Before second sync: ${beforeSecondSync / 10 ** ASSET_DECIMALS}`);
  console.log(`  After second sync:  ${afterSecondSync / 10 ** ASSET_DECIMALS}`);

  if (beforeSecondSync === afterSecondSync) {
    console.log("  ✅ PASSED: Sync is idempotent");
    passed++;
  } else {
    console.log("  ❌ FAILED: Second sync changed total_assets");
    failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Sync function ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
