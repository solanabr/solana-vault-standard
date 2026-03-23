/**
 * SVS-3 View Functions Test
 *
 * Tests view functions on confidential live balance model.
 * SVS-3 uses vault + sharesMint + assetVault (live balance).
 * maxRedeem/maxWithdraw don't need ownerSharesAccount (encrypted).
 *
 * Run: npx ts-node scripts/svs-3/view-functions.ts
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
  setupTest, getVaultPDA, getSharesMintPDA, ASSET_DECIMALS,
  requireBackend, configureUserAccount,
} from "./helpers";

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("View Functions");
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
    .initialize(vaultId, "View Functions Test", "VIEW3", "https://test.com", null)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // SVS-3 view context (live balance: includes assetVault, NO ownerSharesAccount for max*)
  const viewAccounts = { vault, sharesMint, assetVault };

  // SECTION 1: Empty vault
  console.log("=".repeat(70));
  console.log("  SECTION 1: Empty Vault");
  console.log("=".repeat(70));

  const emptyTests: [string, () => Promise<void>][] = [
    ["totalAssets (empty)", () => program.methods.totalAssets().accountsStrict(viewAccounts).rpc().then(() => {})],
    ["maxDeposit (empty)", () => program.methods.maxDeposit().accountsStrict(viewAccounts).rpc().then(() => {})],
    ["maxMint (empty)", () => program.methods.maxMint().accountsStrict(viewAccounts).rpc().then(() => {})],
    ["maxRedeem (empty, CT)", () => program.methods.maxRedeem().accountsStrict(viewAccounts).rpc().then(() => {})],
    ["maxWithdraw (empty, CT)", () => program.methods.maxWithdraw().accountsStrict(viewAccounts).rpc().then(() => {})],
    ["convertToShares", () => program.methods.convertToShares(new BN(1_000_000)).accountsStrict(viewAccounts).rpc().then(() => {})],
    ["convertToAssets", () => program.methods.convertToAssets(new BN(1_000_000_000)).accountsStrict(viewAccounts).rpc().then(() => {})],
    ["previewDeposit", () => program.methods.previewDeposit(new BN(1_000_000)).accountsStrict(viewAccounts).rpc().then(() => {})],
    ["previewMint", () => program.methods.previewMint(new BN(1_000_000_000)).accountsStrict(viewAccounts).rpc().then(() => {})],
  ];

  for (const [name, fn] of emptyTests) {
    console.log(`\n  TEST: ${name}`);
    try { await fn(); console.log("    ✅ PASSED"); passed++; }
    catch (err: any) { console.log(`    ❌ FAILED: ${err.message}`); failed++; }
  }

  // SECTION 2: Funded vault
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 2: Funded Vault");
  console.log("=".repeat(70));

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

  const fundedTests: [string, () => Promise<void>][] = [
    ["totalAssets (funded)", async () => {
      await program.methods.totalAssets().accountsStrict(viewAccounts).rpc();
    }],
    ["previewRedeem (funded)", () => program.methods.previewRedeem(new BN(1_000_000_000)).accountsStrict(viewAccounts).rpc().then(() => {})],
    ["previewWithdraw (funded)", () => program.methods.previewWithdraw(new BN(10_000 * 10 ** ASSET_DECIMALS)).accountsStrict(viewAccounts).rpc().then(() => {})],
  ];

  for (const [name, fn] of fundedTests) {
    console.log(`\n  TEST: ${name}`);
    try { await fn(); console.log("    ✅ PASSED"); passed++; }
    catch (err: any) { console.log(`    ❌ FAILED: ${err.message}`); failed++; }
  }

  // SECTION 3: Paused vault
  console.log("\n" + "=".repeat(70));
  console.log("  SECTION 3: Paused Vault");
  console.log("=".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  console.log("\n  TEST: maxDeposit (paused)");
  try { await program.methods.maxDeposit().accountsStrict(viewAccounts).rpc(); console.log("    ✅ PASSED"); passed++; }
  catch (err: any) { console.log(`    ❌ FAILED: ${err.message}`); failed++; }

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
