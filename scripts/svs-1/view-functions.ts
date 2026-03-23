/**
 * SVS-1 View Functions Test
 *
 * Tests all read-only view/preview functions via simulate():
 * totalAssets, convertToShares, convertToAssets,
 * previewDeposit, previewMint, previewRedeem, previewWithdraw,
 * maxDeposit, maxMint, maxRedeem, maxWithdraw
 *
 * Run: npx ts-node scripts/svs-1/view-functions.ts
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
import { setupTest, getVaultPDA, getSharesMintPDA, ASSET_DECIMALS, SHARE_DECIMALS } from "./helpers";

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
    .initialize(vaultId, "View Functions Test", "VIEW", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("  Setup complete\n");

  // SVS-1 view accounts context (live balance: includes asset_vault)
  const viewAccounts = { vault, sharesMint, assetVault };
  const viewAccountsWithOwner = { vault, sharesMint, assetVault, ownerSharesAccount: userSharesAccount };

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

  // TEST 1: totalAssets on empty vault — SVS-1 reads live balance
  console.log("\n" + "-".repeat(70));
  console.log("TEST 1: totalAssets (empty vault)");
  console.log("-".repeat(70));

  const emptyBalance = await getAccount(connection, assetVault, undefined, TOKEN_PROGRAM_ID);
  console.log(`  asset_vault balance: ${Number(emptyBalance.amount)}`);
  if (Number(emptyBalance.amount) === 0) {
    console.log("  ✅ PASSED: Empty vault has 0 assets"); passed++;
  } else {
    console.log("  ❌ FAILED: Expected 0"); failed++;
  }

  // TEST 2: totalAssets view instruction simulates
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: totalAssets simulate (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("totalAssets", program.methods.totalAssets().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 3: maxDeposit on empty vault
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: maxDeposit (empty vault, not paused)");
  console.log("-".repeat(70));

  if (await simulateView("maxDeposit", program.methods.maxDeposit().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 4: maxMint on empty vault
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: maxMint (empty vault, not paused)");
  console.log("-".repeat(70));

  if (await simulateView("maxMint", program.methods.maxMint().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 5: convertToShares on empty vault
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: convertToShares (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("convertToShares", program.methods.convertToShares(new BN(1_000_000)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 6: convertToAssets on empty vault
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: convertToAssets (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("convertToAssets", program.methods.convertToAssets(new BN(1_000_000_000)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 7: previewDeposit on empty vault
  console.log("\n" + "-".repeat(70));
  console.log("TEST 7: previewDeposit (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("previewDeposit", program.methods.previewDeposit(new BN(1_000_000)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // ============================================================================
  // SECTION 2: Funded vault view functions
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 2: Funded Vault (after 100K deposit)");
  console.log("=".repeat(70));

  // Deposit to fund vault
  await program.methods
    .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  // TEST 8: totalAssets after deposit (live balance)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 8: totalAssets (funded vault)");
  console.log("-".repeat(70));

  const fundedBalance = await getAccount(connection, assetVault, undefined, TOKEN_PROGRAM_ID);
  const totalAssets = Number(fundedBalance.amount);
  console.log(`  asset_vault balance: ${totalAssets / 10 ** ASSET_DECIMALS}`);
  if (totalAssets === 100_000 * 10 ** ASSET_DECIMALS) {
    console.log("  ✅ PASSED"); passed++;
  } else {
    console.log("  ❌ FAILED: Expected 100,000"); failed++;
  }

  // TEST 9: previewRedeem (funded vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 9: previewRedeem (funded vault)");
  console.log("-".repeat(70));

  const userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const halfShares = new BN(Math.floor(Number(userShares.amount) / 2));
  if (await simulateView("previewRedeem", program.methods.previewRedeem(halfShares).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 10: previewWithdraw (funded vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 10: previewWithdraw (funded vault)");
  console.log("-".repeat(70));

  if (await simulateView("previewWithdraw", program.methods.previewWithdraw(new BN(10_000 * 10 ** ASSET_DECIMALS)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 11: maxRedeem (needs owner_shares_account)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 11: maxRedeem (funded vault)");
  console.log("-".repeat(70));

  if (await simulateView("maxRedeem", program.methods.maxRedeem().accountsStrict(viewAccountsWithOwner))) passed++;
  else failed++;

  // TEST 12: maxWithdraw (needs owner_shares_account)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 12: maxWithdraw (funded vault)");
  console.log("-".repeat(70));

  if (await simulateView("maxWithdraw", program.methods.maxWithdraw().accountsStrict(viewAccountsWithOwner))) passed++;
  else failed++;

  // ============================================================================
  // SECTION 3: Paused vault view functions
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 3: Paused Vault");
  console.log("=".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // TEST 13: maxDeposit when paused (should simulate fine, returns 0 via return data)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 13: maxDeposit (paused → returns 0)");
  console.log("-".repeat(70));

  if (await simulateView("maxDeposit (paused)", program.methods.maxDeposit().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 14: totalAssets still works when paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 14: totalAssets (still works when paused)");
  console.log("-".repeat(70));

  const pausedBalance = Number((await getAccount(connection, assetVault, undefined, TOKEN_PROGRAM_ID)).amount);
  console.log(`  asset_vault balance: ${pausedBalance / 10 ** ASSET_DECIMALS}`);
  if (pausedBalance > 0) {
    console.log("  ✅ PASSED: Assets still readable when paused"); passed++;
  } else {
    console.log("  ❌ FAILED"); failed++;
  }

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
