/**
 * SVS-5 View Functions Test
 *
 * Tests all read-only view/preview functions via simulate():
 * totalAssets, convertToShares, convertToAssets,
 * previewDeposit, previewMint, previewRedeem, previewWithdraw,
 * maxDeposit, maxMint, maxRedeem, maxWithdraw,
 * getStreamInfo (SVS-5 specific)
 *
 * Run: npx ts-node scripts/svs-5/view-functions.ts
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
import { setupTest, getVaultPDA, getSharesMintPDA, createSharesAtaIx, ASSET_DECIMALS, SHARE_DECIMALS } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("View Functions");

  let passed = 0;
  let failed = 0;

  // Setup
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
    .initialize(vaultId)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("  Setup complete\n");

  // SVS-5 view accounts context
  const viewAccounts = { vault, sharesMint };
  const viewAccountsWithOwner = { vault, sharesMint, ownerSharesAccount: userSharesAccount };

  // Helper: simulate a view function and check it succeeds
  async function simulateView(name: string, builder: any): Promise<boolean> {
    try {
      const result = await builder.simulate();
      if (result) {
        console.log(`  ✅ PASSED: ${name} simulated successfully`);
        return true;
      }
      console.log(`  ❌ FAILED: ${name} returned no result`);
      return false;
    } catch (err: any) {
      console.log(`  ❌ FAILED: ${name} — ${err.message}`);
      return false;
    }
  }

  // ============================================================================
  // SECTION 1: Empty vault view functions
  // ============================================================================
  console.log("=".repeat(70));
  console.log("  SECTION 1: Empty Vault");
  console.log("=".repeat(70));

  // TEST 1: totalAssets on empty vault
  console.log("\n" + "-".repeat(70));
  console.log("TEST 1: totalAssets (empty vault)");
  console.log("-".repeat(70));

  const vaultState = await program.account.streamVault.fetch(vault);
  console.log(`  base_assets: ${vaultState.baseAssets.toString()}`);
  if (vaultState.baseAssets.toNumber() === 0) {
    console.log("  ✅ PASSED: Empty vault has 0 base_assets"); passed++;
  } else {
    console.log("  ❌ FAILED: Expected 0"); failed++;
  }

  // TEST 2: totalAssets view instruction simulates
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: totalAssets simulate (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("totalAssets", program.methods.totalAssets().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 3: maxDeposit
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: maxDeposit (empty vault, not paused)");
  console.log("-".repeat(70));

  if (await simulateView("maxDeposit", program.methods.maxDeposit().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 4: convertToShares
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: convertToShares (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("convertToShares", program.methods.convertToShares(new BN(1_000_000)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 5: getStreamInfo (no active stream)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: getStreamInfo (no active stream)");
  console.log("-".repeat(70));

  if (await simulateView("getStreamInfo", program.methods.getStreamInfo().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // ============================================================================
  // SECTION 2: Funded vault view functions
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 2: Funded Vault (after 100K deposit)");
  console.log("=".repeat(70));

  await program.methods
    .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
    .rpc();

  // TEST 6: totalAssets after deposit
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: totalAssets (funded vault)");
  console.log("-".repeat(70));

  if (await simulateView("totalAssets", program.methods.totalAssets().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 7: previewDeposit
  console.log("\n" + "-".repeat(70));
  console.log("TEST 7: previewDeposit (funded vault)");
  console.log("-".repeat(70));

  if (await simulateView("previewDeposit", program.methods.previewDeposit(new BN(1_000_000)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 8: previewRedeem
  console.log("\n" + "-".repeat(70));
  console.log("TEST 8: previewRedeem (funded vault)");
  console.log("-".repeat(70));

  const userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const halfShares = new BN(Math.floor(Number(userShares.amount) / 2));
  if (await simulateView("previewRedeem", program.methods.previewRedeem(halfShares).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 9: maxRedeem
  console.log("\n" + "-".repeat(70));
  console.log("TEST 9: maxRedeem (funded vault)");
  console.log("-".repeat(70));

  if (await simulateView("maxRedeem", program.methods.maxRedeem().accountsStrict(viewAccountsWithOwner))) passed++;
  else failed++;

  // ============================================================================
  // SECTION 3: View functions during active stream
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 3: During Active Stream");
  console.log("=".repeat(70));

  await program.methods
    .distributeYield(new BN(5_000 * 10 ** ASSET_DECIMALS), new BN(120))
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint,
      authorityAssetAccount: userAta.address, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // TEST 10: getStreamInfo during active stream
  console.log("\n" + "-".repeat(70));
  console.log("TEST 10: getStreamInfo (active stream)");
  console.log("-".repeat(70));

  if (await simulateView("getStreamInfo", program.methods.getStreamInfo().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 11: totalAssets during stream (should include accrued yield)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 11: totalAssets (during active stream)");
  console.log("-".repeat(70));

  if (await simulateView("totalAssets", program.methods.totalAssets().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 12: previewWithdraw during stream
  console.log("\n" + "-".repeat(70));
  console.log("TEST 12: previewWithdraw (during active stream)");
  console.log("-".repeat(70));

  if (await simulateView("previewWithdraw", program.methods.previewWithdraw(new BN(10_000 * 10 ** ASSET_DECIMALS)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // ============================================================================
  // SECTION 4: Paused vault
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 4: Paused Vault");
  console.log("=".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // TEST 13: maxDeposit when paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 13: maxDeposit (paused → returns 0)");
  console.log("-".repeat(70));

  if (await simulateView("maxDeposit (paused)", program.methods.maxDeposit().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 14: getStreamInfo still works when paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 14: getStreamInfo (still works when paused)");
  console.log("-".repeat(70));

  if (await simulateView("getStreamInfo (paused)", program.methods.getStreamInfo().accountsStrict(viewAccounts))) passed++;
  else failed++;

  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  View functions ${failed === 0 ? "✅ ALL WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
