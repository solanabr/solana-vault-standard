/**
 * SVS-2 View Functions Test
 *
 * Tests all view functions on SVS-2 (stored balance model).
 * Key difference: SVS-2 view accounts use vault + sharesMint (no assetVault).
 *
 * Run: npx ts-node scripts/svs-2/view-functions.ts
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
import { setupTest, getVaultPDA, getSharesMintPDA, ASSET_DECIMALS, SHARE_DECIMALS, syncVault } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("View Functions");

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
    .initialize(vaultId, "View Functions Test", "VIEW2", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // SVS-2 view accounts (stored balance: no assetVault needed)
  const viewAccounts = { vault, sharesMint };
  const viewAccountsWithOwner = { vault, sharesMint, ownerSharesAccount: userSharesAccount };

  // ============================================================================
  // SECTION 1: Empty vault
  // ============================================================================
  console.log("=".repeat(70));
  console.log("  SECTION 1: Empty Vault");
  console.log("=".repeat(70));

  const emptyTests: [string, () => Promise<void>][] = [
    ["totalAssets (empty)", () => program.methods.totalAssets().accountsStrict(viewAccounts).rpc().then(() => {})],
    ["maxDeposit (empty)", () => program.methods.maxDeposit().accountsStrict(viewAccounts).rpc().then(() => {})],
    ["maxMint (empty)", () => program.methods.maxMint().accountsStrict(viewAccounts).rpc().then(() => {})],
    ["convertToShares (empty)", () => program.methods.convertToShares(new BN(1_000_000)).accountsStrict(viewAccounts).rpc().then(() => {})],
    ["convertToAssets (empty)", () => program.methods.convertToAssets(new BN(1_000_000_000)).accountsStrict(viewAccounts).rpc().then(() => {})],
    ["previewDeposit (empty)", () => program.methods.previewDeposit(new BN(1_000_000)).accountsStrict(viewAccounts).rpc().then(() => {})],
    ["previewMint (empty)", () => program.methods.previewMint(new BN(1_000_000_000)).accountsStrict(viewAccounts).rpc().then(() => {})],
  ];

  for (const [name, fn] of emptyTests) {
    console.log(`\n  TEST: ${name}`);
    try {
      await fn();
      console.log("    ✅ PASSED"); passed++;
    } catch (err: any) {
      console.log(`    ❌ FAILED: ${err.message}`); failed++;
    }
  }

  // ============================================================================
  // SECTION 2: Funded vault
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 2: Funded Vault");
  console.log("=".repeat(70));

  await program.methods
    .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const fundedTests: [string, () => Promise<void>][] = [
    ["totalAssets (funded)", async () => {
      await program.methods.totalAssets().accountsStrict(viewAccounts).rpc();
      const v = await program.account.vault.fetch(vault);
      console.log(`      total_assets: ${v.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
    }],
    ["previewRedeem", async () => {
      const shares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      await program.methods.previewRedeem(new BN(Math.floor(Number(shares.amount) / 2))).accountsStrict(viewAccounts).rpc();
    }],
    ["previewWithdraw", () => program.methods.previewWithdraw(new BN(10_000 * 10 ** ASSET_DECIMALS)).accountsStrict(viewAccounts).rpc().then(() => {})],
    ["maxRedeem", () => program.methods.maxRedeem().accountsStrict(viewAccountsWithOwner).rpc().then(() => {})],
    ["maxWithdraw", () => program.methods.maxWithdraw().accountsStrict(viewAccountsWithOwner).rpc().then(() => {})],
  ];

  for (const [name, fn] of fundedTests) {
    console.log(`\n  TEST: ${name}`);
    try {
      await fn();
      console.log("    ✅ PASSED"); passed++;
    } catch (err: any) {
      console.log(`    ❌ FAILED: ${err.message}`); failed++;
    }
  }

  // ============================================================================
  // SECTION 3: Views before/after sync
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 3: View Functions Before/After Sync");
  console.log("=".repeat(70));

  // Direct transfer (yield)
  const { transfer: spl_transfer } = await import("@solana/spl-token");
  await spl_transfer(connection, payer, userAta.address, assetVault, payer, 20_000 * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);

  let vaultState = await program.account.vault.fetch(vault);
  console.log(`\n  Before sync: total_assets = ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  await syncVault(program, payer, vault, assetVault);

  vaultState = await program.account.vault.fetch(vault);
  console.log(`  After sync:  total_assets = ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  console.log("\n  TEST: totalAssets reflects synced value");
  try {
    await program.methods.totalAssets().accountsStrict(viewAccounts).rpc();
    const v = await program.account.vault.fetch(vault);
    if (v.totalAssets.toNumber() === 120_000 * 10 ** ASSET_DECIMALS) {
      console.log("    ✅ PASSED"); passed++;
    } else {
      console.log(`    ❌ FAILED: Expected 120000, got ${v.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`); failed++;
    }
  } catch (err: any) {
    console.log(`    ❌ FAILED: ${err.message}`); failed++;
  }

  // ============================================================================
  // SECTION 4: Paused vault
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 4: Paused Vault");
  console.log("=".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  const pausedTests: [string, () => Promise<void>][] = [
    ["maxDeposit (paused)", () => program.methods.maxDeposit().accountsStrict(viewAccounts).rpc().then(() => {})],
    ["totalAssets (paused)", () => program.methods.totalAssets().accountsStrict(viewAccounts).rpc().then(() => {})],
  ];

  for (const [name, fn] of pausedTests) {
    console.log(`\n  TEST: ${name}`);
    try {
      await fn();
      console.log("    ✅ PASSED"); passed++;
    } catch (err: any) {
      console.log(`    ❌ FAILED: ${err.message}`); failed++;
    }
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
