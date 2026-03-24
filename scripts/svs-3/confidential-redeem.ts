/**
 * SVS-3 Confidential Redeem Test
 *
 * Tests redeem with ZK proofs:
 * - Partial redeem with equality + range proofs
 * - Full redeem (drain)
 *
 * Run: npx ts-node scripts/svs-3/confidential-redeem.ts
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
  requireBackend, configureUserAccount, redeemConfidential,
  deriveAesKeyFromSignature, createDecryptableZeroBalance,
} from "./helpers";

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("Confidential Redeem");
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
    .initialize(vaultId, "CT Redeem Test", "CTRED3", "https://test.com", null)
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
  console.log(`\n  Setup: 100K deposited, ${totalShares / 10 ** SHARE_DECIMALS} shares\n`);

  // ============================================================================
  // TEST 1: Partial redeem
  // ============================================================================
  console.log("=".repeat(70));
  console.log("  TEST 1: Partial Redeem (25%)");
  console.log("=".repeat(70));

  const sharesToRedeem1 = Math.floor(totalShares / 4);
  const assetsBefore1 = Number((await getAccount(connection, userAta.address)).amount);

  try {
    await redeemConfidential(
      provider, program, payer, vault, assetMint, userAta.address,
      assetVault, sharesMint, userSharesAccount, sharesToRedeem1, totalShares
    );

    const assetsAfter1 = Number((await getAccount(connection, userAta.address)).amount);
    const received1 = (assetsAfter1 - assetsBefore1) / 10 ** ASSET_DECIMALS;
    const remainingShares = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);

    console.log(`\n  Redeemed ${sharesToRedeem1 / 10 ** SHARE_DECIMALS} shares`);
    console.log(`  Assets received: ${received1.toLocaleString()}`);
    console.log(`  Remaining shares: ${remainingShares / 10 ** SHARE_DECIMALS}`);

    if (received1 > 0 && remainingShares === totalShares - sharesToRedeem1) {
      console.log("  ✅ PASSED"); passed++;
    } else {
      console.log("  ❌ FAILED: Unexpected amounts"); failed++;
    }
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); failed++;
  }

  // ============================================================================
  // TEST 2: Full redeem (remaining shares)
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 2: Full Redeem (remaining 75%)");
  console.log("=".repeat(70));

  const remainingShares = totalShares - sharesToRedeem1;
  const assetsBefore2 = Number((await getAccount(connection, userAta.address)).amount);

  try {
    await redeemConfidential(
      provider, program, payer, vault, assetMint, userAta.address,
      assetVault, sharesMint, userSharesAccount, remainingShares, remainingShares
    );

    const assetsAfter2 = Number((await getAccount(connection, userAta.address)).amount);
    const received2 = (assetsAfter2 - assetsBefore2) / 10 ** ASSET_DECIMALS;
    const finalSupply = Number((await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID)).supply);
    const finalBalance = Number((await getAccount(connection, assetVault)).amount);

    console.log(`\n  Assets received: ${received2.toLocaleString()}`);
    console.log(`  Final shares supply: ${finalSupply}`);
    console.log(`  Final vault balance: ${finalBalance}`);

    if (finalSupply === 0 && finalBalance === 0) {
      console.log("  ✅ PASSED: Vault fully drained"); passed++;
    } else {
      console.log("  ❌ FAILED: Vault not fully drained"); failed++;
    }
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Confidential redeem ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
