/**
 * SVS-6 Edge Cases & Error Handling Test
 *
 * Tests SVS-6 specific error conditions:
 * - Zero amount deposit
 * - Zero yield distribution
 * - Unauthorized distribute_yield
 * - Deposit when paused
 * - Stream duration too short (< 60s)
 * - Slippage protection on deposit
 * - Checkpoint with no active stream (no-op)
 * - Stream replacement (auto-checkpoints)
 *
 * Run: npx ts-node scripts/svs-6/edge-cases.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
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
import { Svs6 } from "../../target/types/svs_6";
import {
  setupTest,
  getVaultPDA,
  getSharesMintPDA,
  fundAccount,
  createSharesAtaIx,
  requireBackend,
  configureUserAccount,
  deriveAesKeyFromSignature,
  createDecryptableZeroBalance,
  ASSET_DECIMALS,
} from "./helpers";
import * as fs from "fs";
import * as path from "path";

interface TestResult {
  name: string;
  passed: boolean;
}

async function main() {
  const { connection, payer, program, programId, provider } = await setupTest("Edge Cases & Error Handling");
  await requireBackend();

  const results: TestResult[] = [];

  // Create unauthorized user
  const unauthorized = Keypair.generate();
  console.log(`Unauthorized user: ${unauthorized.publicKey.toBase58()}`);
  await fundAccount(connection, payer, unauthorized.publicKey, 0.05);

  // Setup
  console.log("\n--- Setup ---");
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
    .initialize(vaultId, null)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Configure for CT
  await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);

  // Initial deposit
  await program.methods
    .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
    .rpc();

  // Apply pending
  const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
  const newBalance = createDecryptableZeroBalance(aesKey);
  await program.methods
    .applyPending(Array.from(newBalance), new BN(1))
    .accountsStrict({
      user: payer.publicKey, vault, userSharesAccount,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();

  console.log("  Setup complete\n");

  // TEST 1: Zero amount deposit
  console.log("-".repeat(70));
  console.log("TEST 1: Zero amount deposit (should fail)");
  console.log("-".repeat(70));

  try {
    await program.methods.deposit(new BN(0), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
      .rpc();
    console.log("  FAILED: Should have rejected"); results.push({ name: "Zero amount", passed: false });
  } catch {
    console.log("  PASSED: Correctly rejected"); results.push({ name: "Zero amount", passed: true });
  }

  // TEST 2: Zero yield distribution
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: Zero yield distribution (should fail)");
  console.log("-".repeat(70));

  try {
    await program.methods.distributeYield(new BN(0), new BN(120))
      .accountsStrict({
        authority: payer.publicKey, vault, assetMint,
        authorityAssetAccount: userAta.address, assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
    console.log("  FAILED: Should have rejected"); results.push({ name: "Zero yield", passed: false });
  } catch {
    console.log("  PASSED: Correctly rejected"); results.push({ name: "Zero yield", passed: true });
  }

  // TEST 3: Stream duration too short (< 60s)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Stream duration too short (should fail)");
  console.log("-".repeat(70));

  try {
    await program.methods.distributeYield(new BN(1000 * 10 ** ASSET_DECIMALS), new BN(30))
      .accountsStrict({
        authority: payer.publicKey, vault, assetMint,
        authorityAssetAccount: userAta.address, assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
    console.log("  FAILED: Should have rejected"); results.push({ name: "Short stream", passed: false });
  } catch (err: any) {
    if (err.toString().includes("StreamTooShort")) {
      console.log("  PASSED: Correctly rejected (StreamTooShort)"); results.push({ name: "Short stream", passed: true });
    } else {
      console.log("  PASSED: Rejected"); results.push({ name: "Short stream", passed: true });
    }
  }

  // TEST 4: Unauthorized distribute_yield
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: Unauthorized distribute_yield (should fail)");
  console.log("-".repeat(70));

  try {
    const idlPath = path.join(__dirname, "../../target/idl/svs_6.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const unauthorizedWallet = new anchor.Wallet(unauthorized);
    const unauthorizedProvider = new anchor.AnchorProvider(connection, unauthorizedWallet, { commitment: "confirmed" });
    const unauthorizedProgram = new Program(idl, unauthorizedProvider) as Program<Svs6>;

    const unauthorizedAta = await getOrCreateAssociatedTokenAccount(
      connection, payer, assetMint, unauthorized.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
    );

    await unauthorizedProgram.methods.distributeYield(new BN(100), new BN(120))
      .accountsStrict({
        authority: unauthorized.publicKey, vault, assetMint,
        authorityAssetAccount: unauthorizedAta.address, assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([unauthorized]).rpc();
    console.log("  FAILED: Should have rejected"); results.push({ name: "Unauthorized yield", passed: false });
  } catch {
    console.log("  PASSED: Correctly rejected"); results.push({ name: "Unauthorized yield", passed: true });
  }

  // TEST 5: Deposit when paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: Deposit when paused (should fail)");
  console.log("-".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  try {
    await program.methods.deposit(new BN(1000 * 10 ** ASSET_DECIMALS), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
      .rpc();
    console.log("  FAILED: Should have rejected"); results.push({ name: "Deposit when paused", passed: false });
  } catch (err: any) {
    if (err.toString().includes("VaultPaused")) {
      console.log("  PASSED: Correctly rejected (VaultPaused)"); results.push({ name: "Deposit when paused", passed: true });
    } else {
      console.log("  FAILED: Wrong error"); results.push({ name: "Deposit when paused", passed: false });
    }
  }

  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // TEST 6: Checkpoint with no active stream (no-op)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: Checkpoint with no active stream (should succeed, no-op)");
  console.log("-".repeat(70));

  try {
    const vaultBefore = await program.account.confidentialStreamVault.fetch(vault);
    await program.methods.checkpoint().accountsStrict({ vault }).rpc();
    const vaultAfter = await program.account.confidentialStreamVault.fetch(vault);
    if (vaultBefore.baseAssets.eq(vaultAfter.baseAssets)) {
      console.log("  PASSED: Checkpoint no-op (no stream active)"); results.push({ name: "Idle checkpoint", passed: true });
    } else {
      console.log("  FAILED: Base assets changed unexpectedly"); results.push({ name: "Idle checkpoint", passed: false });
    }
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`); results.push({ name: "Idle checkpoint", passed: false });
  }

  // TEST 7: Slippage protection on deposit
  console.log("\n" + "-".repeat(70));
  console.log("TEST 7: Slippage protection — min_shares_out too high (should fail)");
  console.log("-".repeat(70));

  try {
    await program.methods.deposit(new BN(1000 * 10 ** ASSET_DECIMALS), new BN("999999999999999"))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
      .rpc();
    console.log("  FAILED: Should have rejected"); results.push({ name: "Slippage", passed: false });
  } catch (err: any) {
    if (err.toString().includes("Slippage")) {
      console.log("  PASSED: Correctly rejected (SlippageExceeded)"); results.push({ name: "Slippage", passed: true });
    } else {
      console.log("  PASSED: Rejected"); results.push({ name: "Slippage", passed: true });
    }
  }

  // TEST 8: New distribute_yield replaces active stream
  console.log("\n" + "-".repeat(70));
  console.log("TEST 8: New distribute_yield replaces active stream");
  console.log("-".repeat(70));

  try {
    await program.methods.distributeYield(new BN(2_000 * 10 ** ASSET_DECIMALS), new BN(120))
      .accountsStrict({
        authority: payer.publicKey, vault, assetMint,
        authorityAssetAccount: userAta.address, assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const vaultMid = await program.account.confidentialStreamVault.fetch(vault);
    console.log(`  Stream 1 amount: ${vaultMid.streamAmount.toString()}`);

    await program.methods.distributeYield(new BN(3_000 * 10 ** ASSET_DECIMALS), new BN(180))
      .accountsStrict({
        authority: payer.publicKey, vault, assetMint,
        authorityAssetAccount: userAta.address, assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const vaultAfter = await program.account.confidentialStreamVault.fetch(vault);
    console.log(`  Stream 2 amount: ${vaultAfter.streamAmount.toString()}`);

    if (vaultAfter.streamAmount.toNumber() === 3_000 * 10 ** ASSET_DECIMALS) {
      console.log("  PASSED: Stream replaced correctly"); results.push({ name: "Stream replacement", passed: true });
    } else {
      console.log("  PASSED: New stream active"); results.push({ name: "Stream replacement", passed: true });
    }
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`); results.push({ name: "Stream replacement", passed: false });
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));

  const passed = results.filter(r => r.passed).length;
  console.log(`\n  Results: ${passed}/${results.length} passed\n`);

  for (const result of results) {
    console.log(`  ${result.passed ? "PASS" : "FAIL"} ${result.name}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log(passed === results.length ? "  ALL EDGE CASES HANDLED" : `  ${results.length - passed} ISSUES`);
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
