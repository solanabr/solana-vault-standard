/**
 * SVS-3 Confidential Deposit Test
 *
 * Tests deposit flow with CT:
 * - Multiple deposits with pending balance tracking
 * - apply_pending between deposits
 * - Pending balance credit counter
 *
 * Run: npx ts-node scripts/svs-3/confidential-deposit.ts
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
  getMint,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  setupTest, getVaultPDA, getSharesMintPDA, ASSET_DECIMALS, SHARE_DECIMALS,
  requireBackend, configureUserAccount,
  deriveAesKeyFromSignature, createDecryptableZeroBalance,
} from "./helpers";

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("Confidential Deposit");
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
  await mintTo(connection, payer, assetMint, userAta.address, payer, 1_000_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .initialize(vaultId, "CT Deposit Test", "CTDEP3", "https://test.com", null)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Configure for CT (creates ATA internally + sets up CT extension)
  await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);

  await program.methods
    .deposit(new BN(1000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);

  // ============================================================================
  // TEST 1: First deposit + apply_pending
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 1: Deposit + Apply Pending");
  console.log("=".repeat(70));

  const supplyBefore = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);

  await program.methods
    .deposit(new BN(50_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const supplyAfter1 = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);
  const sharesDeposit1 = supplyAfter1 - supplyBefore;
  console.log(`\n  Deposit 1: 50K tokens → ${sharesDeposit1 / 10 ** SHARE_DECIMALS} shares`);

  // Apply pending (counter = 2 because we had initial deposit + this one)
  const newBalance1 = createDecryptableZeroBalance(aesKey);
  try {
    await program.methods
      .applyPending(Array.from(newBalance1), new BN(2))
      .accountsStrict({
        user: payer.publicKey, vault, userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log("  apply_pending(counter=2): ✅"); passed++;
  } catch (err: any) {
    console.log(`  apply_pending failed: ${err.message}`); failed++;
  }

  // ============================================================================
  // TEST 2: Second deposit
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 2: Second Deposit");
  console.log("=".repeat(70));

  await program.methods
    .deposit(new BN(25_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const supplyAfter2 = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);
  const sharesDeposit2 = supplyAfter2 - supplyAfter1;
  console.log(`\n  Deposit 2: 25K tokens → ${sharesDeposit2 / 10 ** SHARE_DECIMALS} shares`);

  // Apply pending (counter = 3)
  const newBalance2 = createDecryptableZeroBalance(aesKey);
  try {
    await program.methods
      .applyPending(Array.from(newBalance2), new BN(3))
      .accountsStrict({
        user: payer.publicKey, vault, userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log("  apply_pending(counter=3): ✅"); passed++;
  } catch (err: any) {
    console.log(`  apply_pending failed: ${err.message}`); failed++;
  }

  // ============================================================================
  // TEST 3: Verify total state
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 3: Verify Total State");
  console.log("=".repeat(70));

  const vaultState = await program.account.confidentialVault.fetch(vault);
  const finalMint = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
  const vaultBalance = await getAccount(connection, assetVault);

  console.log(`\n  Total deposited: ${(1000 + 50_000 + 25_000).toLocaleString()} tokens`);
  console.log(`  Vault balance:   ${Number(vaultBalance.amount) / 10 ** ASSET_DECIMALS}`);
  console.log(`  Total shares:    ${Number(finalMint.supply) / 10 ** SHARE_DECIMALS}`);

  if (Number(vaultBalance.amount) === (1000 + 50_000 + 25_000) * 10 ** ASSET_DECIMALS) {
    console.log("  ✅ PASSED: Vault balance matches deposits"); passed++;
  } else {
    console.log("  ❌ FAILED: Balance mismatch"); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Confidential deposits ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
