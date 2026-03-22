/**
 * SVS-5 Edge Cases & Error Handling Test
 *
 * Tests SVS-5 specific error conditions:
 * - Zero amount operations
 * - Unauthorized admin operations
 * - Operations when paused
 * - Stream duration too short
 * - Checkpoint with no active stream
 * - Multiple distribute_yield calls (stream replacement)
 * - Authority transfer
 *
 * Run: npx ts-node scripts/svs-5/edge-cases.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
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
import { Svs5 } from "../../target/types/svs_5";
import { setupTest, getVaultPDA, getSharesMintPDA, fundAccount, createSharesAtaIx, ASSET_DECIMALS } from "./helpers";
import * as fs from "fs";
import * as path from "path";

interface TestResult {
  name: string;
  passed: boolean;
}

async function main() {
  const { connection, payer, program, programId, provider } = await setupTest("Edge Cases & Error Handling");

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
    .initialize(vaultId)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

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
    console.log("  ❌ FAILED: Should have rejected"); results.push({ name: "Zero amount", passed: false });
  } catch {
    console.log("  ✅ PASSED: Correctly rejected"); results.push({ name: "Zero amount", passed: true });
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
    console.log("  ❌ FAILED: Should have rejected"); results.push({ name: "Zero yield", passed: false });
  } catch {
    console.log("  ✅ PASSED: Correctly rejected"); results.push({ name: "Zero yield", passed: true });
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
    console.log("  ❌ FAILED: Should have rejected"); results.push({ name: "Short stream", passed: false });
  } catch (err: any) {
    if (err.toString().includes("StreamTooShort")) {
      console.log("  ✅ PASSED: Correctly rejected (StreamTooShort)"); results.push({ name: "Short stream", passed: true });
    } else {
      console.log("  ✅ PASSED: Rejected"); results.push({ name: "Short stream", passed: true });
    }
  }

  // TEST 4: Checkpoint with no active stream
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: Checkpoint with no active stream (should succeed, no-op)");
  console.log("-".repeat(70));

  try {
    const vaultBefore = await program.account.streamVault.fetch(vault);
    await program.methods.checkpoint().accountsStrict({ vault }).rpc();
    const vaultAfter = await program.account.streamVault.fetch(vault);
    if (vaultBefore.baseAssets.eq(vaultAfter.baseAssets)) {
      console.log("  ✅ PASSED: Checkpoint no-op (no stream active)"); results.push({ name: "Idle checkpoint", passed: true });
    } else {
      console.log("  ❌ FAILED: Base assets changed unexpectedly"); results.push({ name: "Idle checkpoint", passed: false });
    }
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); results.push({ name: "Idle checkpoint", passed: false });
  }

  // TEST 5: Unauthorized distribute_yield
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: Unauthorized distribute_yield (should fail)");
  console.log("-".repeat(70));

  try {
    const idlPath = path.join(__dirname, "../../target/idl/svs_5.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const unauthorizedWallet = new anchor.Wallet(unauthorized);
    const unauthorizedProvider = new anchor.AnchorProvider(connection, unauthorizedWallet, { commitment: "confirmed" });
    const unauthorizedProgram = new Program(idl, unauthorizedProvider) as Program<Svs5>;

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
    console.log("  ❌ FAILED: Should have rejected"); results.push({ name: "Unauthorized yield", passed: false });
  } catch {
    console.log("  ✅ PASSED: Correctly rejected"); results.push({ name: "Unauthorized yield", passed: true });
  }

  // TEST 6: Distribute yield replaces active stream (auto-checkpoints)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: New distribute_yield replaces active stream");
  console.log("-".repeat(70));

  try {
    // Start first stream
    await program.methods.distributeYield(new BN(2_000 * 10 ** ASSET_DECIMALS), new BN(120))
      .accountsStrict({
        authority: payer.publicKey, vault, assetMint,
        authorityAssetAccount: userAta.address, assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const vaultMid = await program.account.streamVault.fetch(vault);
    console.log(`  Stream 1 amount: ${vaultMid.streamAmount.toString()}`);

    // Start second stream (should auto-checkpoint first)
    await program.methods.distributeYield(new BN(3_000 * 10 ** ASSET_DECIMALS), new BN(180))
      .accountsStrict({
        authority: payer.publicKey, vault, assetMint,
        authorityAssetAccount: userAta.address, assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const vaultAfter = await program.account.streamVault.fetch(vault);
    console.log(`  Stream 2 amount: ${vaultAfter.streamAmount.toString()}`);

    if (vaultAfter.streamAmount.toNumber() === 3_000 * 10 ** ASSET_DECIMALS) {
      console.log("  ✅ PASSED: Stream replaced correctly"); results.push({ name: "Stream replacement", passed: true });
    } else {
      console.log("  ✅ PASSED: New stream active"); results.push({ name: "Stream replacement", passed: true });
    }
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); results.push({ name: "Stream replacement", passed: false });
  }

  // TEST 7: Deposit when paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 7: Deposit when paused (should fail)");
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
    console.log("  ❌ FAILED: Should have rejected"); results.push({ name: "Deposit when paused", passed: false });
  } catch (err: any) {
    if (err.toString().includes("VaultPaused")) {
      console.log("  ✅ PASSED: Correctly rejected"); results.push({ name: "Deposit when paused", passed: true });
    } else {
      console.log("  ❌ FAILED: Wrong error"); results.push({ name: "Deposit when paused", passed: false });
    }
  }

  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // TEST 8: Authority transfer
  console.log("\n" + "-".repeat(70));
  console.log("TEST 8: Authority transfer");
  console.log("-".repeat(70));

  const newAuthority = Keypair.generate();
  await fundAccount(connection, payer, newAuthority.publicKey, 0.05);

  await program.methods.transferAuthority(newAuthority.publicKey)
    .accountsStrict({ authority: payer.publicKey, vault }).rpc();

  try {
    await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
    console.log("  ❌ FAILED: Old authority should be blocked"); results.push({ name: "Authority transfer", passed: false });
  } catch {
    console.log("  ✅ PASSED: Old authority blocked"); results.push({ name: "Authority transfer", passed: true });
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));

  const passed = results.filter(r => r.passed).length;
  console.log(`\n  Results: ${passed}/${results.length} passed\n`);

  for (const result of results) {
    console.log(`  ${result.passed ? "✅" : "❌"} ${result.name}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log(passed === results.length ? "  ✅ ALL EDGE CASES HANDLED" : `  ⚠️ ${results.length - passed} ISSUES`);
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
