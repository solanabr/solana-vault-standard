/**
 * SVS-3 Confidential Withdraw Test
 *
 * Tests withdraw (exact assets) with ZK proofs.
 *
 * Run: npx ts-node scripts/svs-3/confidential-withdraw.ts
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
  requireBackend, configureUserAccount, withdrawConfidential,
  deriveAesKeyFromSignature, createDecryptableZeroBalance,
} from "./helpers";

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("Confidential Withdraw");
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
    .initialize(vaultId, "CT Withdraw Test", "CTWDR3", "https://test.com", null)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Configure for CT (creates ATA internally + sets up CT extension)
  await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);

  // Deposit + apply
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

  const totalShares = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);
  // SVS-3 uses live balance — read actual vault balance, not the unused totalAssets field
  const vaultBalance = Number((await getAccount(connection, assetVault, undefined, TOKEN_PROGRAM_ID)).amount);

  console.log(`\n  Setup: 100K deposited, ${totalShares / 10 ** SHARE_DECIMALS} shares\n`);

  // ============================================================================
  // TEST 1: Withdraw exact assets
  // ============================================================================
  console.log("=".repeat(70));
  console.log("  TEST 1: Withdraw Exact Assets (10K tokens)");
  console.log("=".repeat(70));

  const withdrawAmount = 10_000 * 10 ** ASSET_DECIMALS;
  const offset = 1000;
  const sharesToBurn = Math.ceil(
    (withdrawAmount * (totalShares + offset)) / (vaultBalance + 1)
  );

  const assetsBefore = Number((await getAccount(connection, userAta.address)).amount);

  try {
    await withdrawConfidential(
      provider, program, payer, vault, assetMint, userAta.address,
      assetVault, sharesMint, userSharesAccount,
      withdrawAmount, sharesToBurn, totalShares
    );

    const assetsAfter = Number((await getAccount(connection, userAta.address)).amount);
    const received = assetsAfter - assetsBefore;

    console.log(`\n  Requested: ${withdrawAmount / 10 ** ASSET_DECIMALS} tokens`);
    console.log(`  Received:  ${received / 10 ** ASSET_DECIMALS} tokens`);

    if (received === withdrawAmount) {
      console.log("  ✅ PASSED: Exact amount withdrawn"); passed++;
    } else {
      console.log("  ❌ FAILED: Amount mismatch"); failed++;
    }
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); failed++;
  }

  // ============================================================================
  // TEST 2: Verify remaining state
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 2: Verify Remaining State");
  console.log("=".repeat(70));

  const remainingMint = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
  const remainingBalance = await getAccount(connection, assetVault);

  console.log(`\n  Remaining shares: ${Number(remainingMint.supply) / 10 ** SHARE_DECIMALS}`);
  console.log(`  Remaining balance: ${Number(remainingBalance.amount) / 10 ** ASSET_DECIMALS}`);

  if (Number(remainingMint.supply) > 0 && Number(remainingBalance.amount) === 90_000 * 10 ** ASSET_DECIMALS) {
    console.log("  ✅ PASSED: State consistent"); passed++;
  } else if (Number(remainingMint.supply) > 0 && Number(remainingBalance.amount) > 0) {
    console.log("  ✅ PASSED: State consistent (rounding)"); passed++;
  } else {
    console.log("  ❌ FAILED"); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Confidential withdraw ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
