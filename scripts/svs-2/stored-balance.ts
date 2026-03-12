/**
 * SVS-2 Stored vs Actual Balance Test
 *
 * Tests the stored balance model specific to SVS-2:
 * - Deposits update stored total_assets
 * - Direct transfers create discrepancy
 * - Share price uses stored value, not actual
 * - Deposits before/after sync get different share prices
 *
 * Run: npx ts-node scripts/svs-2/stored-balance.ts
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
import { setupTest, getVaultPDA, getSharesMintPDA, syncVault, fundAccounts, ASSET_DECIMALS, SHARE_DECIMALS } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("Stored vs Actual Balance");

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

  const user2 = Keypair.generate();
  await fundAccounts(connection, payer, [user2.publicKey], 0.05);
  const user2Ata = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, user2.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  await mintTo(connection, payer, assetMint, user2Ata.address, payer, 1_000_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const user2SharesAccount = getAssociatedTokenAddressSync(
    sharesMint, user2.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .initialize(vaultId, "Stored Balance Test", "STORE2", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // ============================================================================
  // TEST 1: Deposit updates stored total_assets
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 1: Deposit Updates Stored total_assets");
  console.log("=".repeat(70));

  const depositAmount = 100_000 * 10 ** ASSET_DECIMALS;
  await program.methods
    .deposit(new BN(depositAmount), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  let vaultState = await program.account.vault.fetch(vault);
  let actualBalance = await getAccount(connection, assetVault);

  console.log(`\n  Stored total_assets: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`  Actual balance:      ${Number(actualBalance.amount) / 10 ** ASSET_DECIMALS}`);

  if (vaultState.totalAssets.toNumber() === Number(actualBalance.amount)) {
    console.log("  ✅ PASSED: Deposit correctly updates stored balance"); passed++;
  } else {
    console.log("  ❌ FAILED"); failed++;
  }

  // ============================================================================
  // TEST 2: Direct transfer creates discrepancy
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 2: Direct Transfer Creates Discrepancy");
  console.log("=".repeat(70));

  const donation = 50_000 * 10 ** ASSET_DECIMALS;
  await transfer(connection, payer, userAta.address, assetVault, payer, donation, [], undefined, TOKEN_PROGRAM_ID);

  vaultState = await program.account.vault.fetch(vault);
  actualBalance = await getAccount(connection, assetVault);

  const discrepancy = Number(actualBalance.amount) - vaultState.totalAssets.toNumber();

  console.log(`\n  Stored total_assets: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`  Actual balance:      ${Number(actualBalance.amount) / 10 ** ASSET_DECIMALS}`);
  console.log(`  Discrepancy:         ${discrepancy / 10 ** ASSET_DECIMALS}`);

  if (discrepancy === donation) {
    console.log("  ✅ PASSED: Discrepancy equals donation amount"); passed++;
  } else {
    console.log("  ❌ FAILED"); failed++;
  }

  // ============================================================================
  // TEST 3: Deposit before sync uses stale share price
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 3: Deposit Before Sync Uses Stale Share Price");
  console.log("=".repeat(70));

  const supplyBefore = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);

  await program.methods
    .deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: user2.publicKey, vault, assetMint, userAssetAccount: user2Ata.address,
      assetVault, sharesMint, userSharesAccount: user2SharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([user2])
    .rpc();

  const supplyAfterPreSync = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);
  const sharesBeforeSync = supplyAfterPreSync - supplyBefore;

  console.log(`\n  User2 deposited 10K (before sync): ${sharesBeforeSync / 10 ** SHARE_DECIMALS} shares`);

  // ============================================================================
  // TEST 4: Deposit after sync uses updated share price
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 4: Deposit After Sync Uses Updated Share Price");
  console.log("=".repeat(70));

  // Sync to recognize the donation
  await syncVault(program, payer, vault, assetVault);

  vaultState = await program.account.vault.fetch(vault);
  console.log(`\n  total_assets after sync: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  const supplyAfterSync = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);

  await program.methods
    .deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: user2.publicKey, vault, assetMint, userAssetAccount: user2Ata.address,
      assetVault, sharesMint, userSharesAccount: user2SharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([user2])
    .rpc();

  const supplyAfterPostSync = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);
  const sharesAfterSync = supplyAfterPostSync - supplyAfterSync;

  console.log(`  User2 deposited 10K (after sync):  ${sharesAfterSync / 10 ** SHARE_DECIMALS} shares`);

  if (sharesAfterSync < sharesBeforeSync) {
    console.log("  ✅ PASSED: Fewer shares after sync (donation recognized in price)"); passed++;
  } else {
    console.log("  ❌ FAILED: Expected fewer shares after sync"); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Stored balance model ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
