/**
 * SVS-4 Sync + Confidential Test
 *
 * Tests sync() interaction with encrypted share balances:
 * - Sync updates stored total_assets
 * - Second deposit after sync uses updated share price
 * - Donation without sync is invisible to stored balance
 *
 * Run: npx ts-node scripts/svs-4/sync-confidential.ts
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
  getMint,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  setupTest, getVaultPDA, getSharesMintPDA, ASSET_DECIMALS, SHARE_DECIMALS,
  requireBackend, configureUserAccount, syncVault,
  deriveAesKeyFromSignature, createDecryptableZeroBalance,
} from "./helpers";

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("Sync + Confidential");
  await requireBackend();

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
    .initialize(vaultId, "Sync CT Test", "SYNCT4", "https://test.com", null)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Configure for CT (creates ATA internally + sets up CT extension)
  await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);

  // Deposit
  await program.methods
    .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
  await program.methods
    .applyPending(Array.from(createDecryptableZeroBalance(aesKey)), new BN(1))
    .accountsStrict({
      user: payer.publicKey, vault, userSharesAccount,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();

  // ============================================================================
  // TEST 1: Donation without sync doesn't change stored total_assets
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 1: Donation Without Sync");
  console.log("=".repeat(70));

  let vs = await program.account.confidentialVault.fetch(vault);
  const storedBefore = vs.totalAssets.toNumber();

  await transfer(connection, payer, userAta.address, assetVault, payer,
    50_000 * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);

  vs = await program.account.confidentialVault.fetch(vault);

  console.log(`\n  Stored before: ${storedBefore / 10 ** ASSET_DECIMALS}`);
  console.log(`  Stored after donation: ${vs.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  if (vs.totalAssets.toNumber() === storedBefore) {
    console.log("  ✅ PASSED: Donation invisible to stored balance"); passed++;
  } else {
    console.log("  ❌ FAILED"); failed++;
  }

  // ============================================================================
  // TEST 2: Sync updates stored total_assets
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 2: Sync Updates Stored Balance");
  console.log("=".repeat(70));

  await syncVault(program, payer, vault, assetVault);

  vs = await program.account.confidentialVault.fetch(vault);
  const actualBalance = Number((await getAccount(connection, assetVault)).amount);

  console.log(`\n  Stored after sync: ${vs.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`  Actual balance:    ${actualBalance / 10 ** ASSET_DECIMALS}`);

  if (vs.totalAssets.toNumber() === actualBalance) {
    console.log("  ✅ PASSED: Sync matched stored to actual"); passed++;
  } else {
    console.log("  ❌ FAILED"); failed++;
  }

  // ============================================================================
  // TEST 3: Second deposit gets fewer shares (price increased)
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 3: Second Deposit After Sync (Fewer Shares)");
  console.log("=".repeat(70));

  const supplyBefore = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);

  await program.methods
    .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const supplyAfter = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);
  const secondShares = supplyAfter - supplyBefore;

  console.log(`\n  First deposit shares:  ${supplyBefore / 10 ** SHARE_DECIMALS}`);
  console.log(`  Second deposit shares: ${secondShares / 10 ** SHARE_DECIMALS}`);

  if (secondShares < supplyBefore) {
    console.log("  ✅ PASSED: Fewer shares (donation recognized in price)"); passed++;
  } else {
    console.log("  ❌ FAILED: Expected fewer shares"); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Sync + Confidential ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
