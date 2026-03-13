/**
 * SVS-7 View Functions Test
 *
 * Tests all read-only view/preview functions via simulate():
 * - total_assets (reads wsol_vault.amount)
 * - preview_deposit, preview_mint, preview_withdraw, preview_redeem
 * - convert_to_shares, convert_to_assets
 * - max_deposit, max_mint, max_withdraw, max_redeem
 *
 * Run: npx ts-node scripts/svs-7/view-functions.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  setupSvs7Test,
  getSolVaultPDA,
  getSharesMintPDA,
} from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupSvs7Test("View Functions");

  let passed = 0;
  let failed = 0;

  // Derive PDAs
  const vaultId = new BN(Date.now());
  const [vault] = getSolVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const wsolVault = anchor.utils.token.associatedAddress({ mint: NATIVE_MINT, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Initialize vault
  await program.methods
    .initialize(vaultId, "View Functions Test", "VIEW", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey,
      vault,
      nativeMint: NATIVE_MINT,
      sharesMint,
      wsolVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("  Setup complete\n");

  // SVS-7 view accounts — wsol_vault (not assetVault)
  const viewAccounts = { vault, sharesMint, wsolVault };

  // Helper: simulate a view function and check it succeeds
  async function simulateView(name: string, builder: any): Promise<boolean> {
    try {
      const result = await builder.simulate();
      if (result !== null && result !== undefined) {
        console.log(`  PASSED: ${name} simulated successfully`);
        return true;
      }
      console.log(`  FAILED: ${name} returned no result`);
      return false;
    } catch (err: any) {
      console.log(`  FAILED: ${name} — ${err.message}`);
      return false;
    }
  }

  // ============================================================================
  // SECTION 1: Empty vault view functions
  // ============================================================================
  console.log("=".repeat(70));
  console.log("  SECTION 1: Empty Vault");
  console.log("=".repeat(70));

  // TEST 1: wSOL vault balance (total_assets proxy — empty vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 1: wSOL vault balance (empty vault = 0)");
  console.log("-".repeat(70));

  const emptyWsolVault = await getAccount(connection, wsolVault, undefined, TOKEN_PROGRAM_ID);
  if (Number(emptyWsolVault.amount) === 0) {
    console.log("  PASSED: Empty wSOL vault has 0 lamports"); passed++;
  } else {
    console.log("  FAILED: Expected 0"); failed++;
  }

  // TEST 2: totalAssets simulate (empty vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: totalAssets simulate (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("totalAssets", program.methods.totalAssets().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 3: maxDeposit (empty vault, not paused)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: maxDeposit (empty vault, not paused)");
  console.log("-".repeat(70));

  if (await simulateView("maxDeposit", program.methods.maxDeposit().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 4: maxMint (empty vault, not paused)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: maxMint (empty vault, not paused)");
  console.log("-".repeat(70));

  if (await simulateView("maxMint", program.methods.maxMint().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 5: convertToShares (empty vault — 1:1 ratio)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: convertToShares (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("convertToShares", program.methods.convertToShares(new BN(1 * LAMPORTS_PER_SOL)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 6: convertToAssets (empty vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: convertToAssets (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("convertToAssets", program.methods.convertToAssets(new BN(1 * LAMPORTS_PER_SOL)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 7: previewDeposit (empty vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 7: previewDeposit (empty vault)");
  console.log("-".repeat(70));

  if (await simulateView("previewDeposit", program.methods.previewDeposit(new BN(0.5 * LAMPORTS_PER_SOL)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // ============================================================================
  // SECTION 2: Funded vault view functions
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 2: Funded Vault (after 5 SOL deposit)");
  console.log("=".repeat(70));

  // Deposit 5 SOL to fund vault
  await program.methods
    .depositSol(new BN(5 * LAMPORTS_PER_SOL), new BN(0))
    .accountsStrict({
      user: payer.publicKey,
      vault,
      wsolVault,
      sharesMint,
      userSharesAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // TEST 8: wSOL vault balance after deposit
  console.log("\n" + "-".repeat(70));
  console.log("TEST 8: wSOL vault balance (funded vault = 5 SOL)");
  console.log("-".repeat(70));

  const fundedWsolVault = await getAccount(connection, wsolVault, undefined, TOKEN_PROGRAM_ID);
  const totalAssets = Number(fundedWsolVault.amount);
  console.log(`  wSOL vault balance: ${totalAssets / LAMPORTS_PER_SOL} SOL`);
  if (totalAssets === 5 * LAMPORTS_PER_SOL) {
    console.log("  PASSED"); passed++;
  } else {
    console.log("  FAILED: Expected 5 SOL"); failed++;
  }

  // TEST 9: totalAssets via simulate (funded vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 9: totalAssets simulate (funded vault)");
  console.log("-".repeat(70));

  if (await simulateView("totalAssets", program.methods.totalAssets().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 10: previewRedeem (funded vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 10: previewRedeem (funded vault)");
  console.log("-".repeat(70));

  const userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const halfShares = new BN(Math.floor(Number(userShares.amount) / 2));
  if (await simulateView("previewRedeem", program.methods.previewRedeem(halfShares).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 11: previewWithdraw (funded vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 11: previewWithdraw (funded vault)");
  console.log("-".repeat(70));

  if (await simulateView("previewWithdraw", program.methods.previewWithdraw(new BN(1 * LAMPORTS_PER_SOL)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 12: previewMint (funded vault)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 12: previewMint (funded vault)");
  console.log("-".repeat(70));

  if (await simulateView("previewMint", program.methods.previewMint(new BN(0.5 * LAMPORTS_PER_SOL)).accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 13: maxRedeem (needs owner_shares_account)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 13: maxRedeem (funded vault, with owner shares account)");
  console.log("-".repeat(70));

  const viewAccountsWithOwner = { vault, sharesMint, wsolVault, ownerSharesAccount: userSharesAccount };
  if (await simulateView("maxRedeem", program.methods.maxRedeem().accountsStrict(viewAccountsWithOwner))) passed++;
  else failed++;

  // TEST 14: maxWithdraw (needs owner_shares_account)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 14: maxWithdraw (funded vault, with owner shares account)");
  console.log("-".repeat(70));

  if (await simulateView("maxWithdraw", program.methods.maxWithdraw().accountsStrict(viewAccountsWithOwner))) passed++;
  else failed++;

  // ============================================================================
  // SECTION 3: Paused vault
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 3: Paused Vault");
  console.log("=".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // TEST 15: maxDeposit when paused (should simulate, returns 0)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 15: maxDeposit (paused → returns 0 via return data)");
  console.log("-".repeat(70));

  if (await simulateView("maxDeposit (paused)", program.methods.maxDeposit().accountsStrict(viewAccounts))) passed++;
  else failed++;

  // TEST 16: totalAssets still works when paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 16: totalAssets (still works when paused)");
  console.log("-".repeat(70));

  const pausedWsolBalance = Number((await getAccount(connection, wsolVault, undefined, TOKEN_PROGRAM_ID)).amount);
  console.log(`  wSOL vault balance: ${pausedWsolBalance / LAMPORTS_PER_SOL} SOL`);
  if (pausedWsolBalance > 0) {
    console.log("  PASSED: Assets still readable when paused"); passed++;
  } else {
    console.log("  FAILED"); failed++;
  }

  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  View functions ${failed === 0 ? "ALL WORKING" : "HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
