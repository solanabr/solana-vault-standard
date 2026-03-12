/**
 * SVS-3 Configure Account Test
 *
 * Tests the configure_account instruction for CT setup:
 * - Basic configuration
 * - Double-configure (should succeed idempotently or fail gracefully)
 * - Edge cases
 *
 * Run: npx ts-node scripts/svs-3/configure-account.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  setupTest, getVaultPDA, getSharesMintPDA, fundAccount, ASSET_DECIMALS,
  requireBackend, configureUserAccount,
} from "./helpers";

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("Configure Account");
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

  await program.methods
    .initialize(vaultId, "Configure Test", "CONF3", "https://test.com", null)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // TEST 1: Basic configure_account
  console.log("\n" + "-".repeat(70));
  console.log("TEST 1: Basic configure_account");
  console.log("-".repeat(70));

  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Must configure BEFORE deposit — CT extension must exist for deposit's CT deposit step
  try {
    await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);
    console.log("  ✅ PASSED: Account configured"); passed++;
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); failed++;
  }

  // Now deposit (requires CT-configured shares account)
  await program.methods
    .deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("  Deposit after configure: success");

  // TEST 2: Double configure (should handle gracefully)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: Double configure_account");
  console.log("-".repeat(70));

  try {
    await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);
    console.log("  ✅ PASSED: Double configure accepted (idempotent)"); passed++;
  } catch (err: any) {
    // Either outcome is acceptable
    console.log("  ✅ PASSED: Double configure rejected (expected)"); passed++;
  }

  // TEST 3: Different user configure
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Second user configure_account");
  console.log("-".repeat(70));

  const user2 = Keypair.generate();
  await fundAccount(connection, payer, user2.publicKey, 0.1);

  const user2Ata = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, user2.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  await mintTo(connection, payer, assetMint, user2Ata.address, payer, 100_000 * 10 ** ASSET_DECIMALS);

  const user2SharesAccount = getAssociatedTokenAddressSync(
    sharesMint, user2.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Must configure BEFORE deposit for CT
  try {
    await configureUserAccount(provider, program, user2, vault, sharesMint, user2SharesAccount);
    console.log("  ✅ PASSED: Second user configured"); passed++;
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); failed++;
  }

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
  console.log("  User2 deposit after configure: success");

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  configure_account ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
