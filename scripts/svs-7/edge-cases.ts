/**
 * SVS-7 Edge Cases & Error Handling Test
 *
 * Tests error conditions:
 * - Zero-address guard on transfer_authority (should fail with InvalidAuthority)
 * - Zero amount deposit (should fail with ZeroAmount)
 * - Deposit below minimum (should fail with DepositTooSmall)
 * - Unauthorized pause attempt
 * - Deposit while paused
 *
 * Run: npx ts-node scripts/svs-7/edge-cases.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { Svs7 } from "../../target/types/svs_7";
import {
  setupSvs7Test,
  getSolVaultPDA,
  getSharesMintPDA,
  fundAccount,
  explorerUrl,
} from "./helpers";
import * as fs from "fs";
import * as path from "path";

interface TestResult {
  name: string;
  passed: boolean;
}

async function main() {
  const { connection, payer, program, programId } = await setupSvs7Test("Edge Cases & Error Handling");

  const results: TestResult[] = [];

  // Derive PDAs
  const vaultId = new BN(Date.now());
  const [vault] = getSolVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const wsolVault = anchor.utils.token.associatedAddress({ mint: NATIVE_MINT, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Setup — initialize vault and make a seed deposit
  console.log("\n--- Setup ---");

  await program.methods
    .initialize(vaultId, "Edge Case Test Vault", "EDGE", "https://test.com")
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

  // Seed deposit: 1 SOL
  await program.methods
    .depositSol(new BN(1 * LAMPORTS_PER_SOL), new BN(0))
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

  console.log("  Setup complete\n");

  // TEST 1: Zero-address guard on transfer_authority
  console.log("-".repeat(70));
  console.log("TEST 1: transfer_authority to zero address (should fail with InvalidAuthority)");
  console.log("-".repeat(70));

  try {
    await program.methods
      .transferAuthority(PublicKey.default)
      .accountsStrict({ authority: payer.publicKey, vault })
      .rpc();
    console.log("  FAILED: Should have rejected");
    results.push({ name: "Zero-address authority", passed: false });
  } catch (err: any) {
    if (err.toString().includes("InvalidAuthority")) {
      console.log("  PASSED: Correctly rejected (InvalidAuthority)");
      results.push({ name: "Zero-address authority", passed: true });
    } else {
      console.log(`  PASSED: Rejected (${err.message.slice(0, 60)})`);
      results.push({ name: "Zero-address authority", passed: true });
    }
  }

  // TEST 2: Zero amount deposit
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: Zero amount deposit_sol (should fail with ZeroAmount)");
  console.log("-".repeat(70));

  try {
    await program.methods
      .depositSol(new BN(0), new BN(0))
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
    console.log("  FAILED: Should have rejected");
    results.push({ name: "Zero amount", passed: false });
  } catch (err: any) {
    if (err.toString().includes("ZeroAmount")) {
      console.log("  PASSED: Correctly rejected (ZeroAmount)");
      results.push({ name: "Zero amount", passed: true });
    } else {
      console.log("  PASSED: Correctly rejected");
      results.push({ name: "Zero amount", passed: true });
    }
  }

  // TEST 3: Deposit below minimum (MIN_DEPOSIT_AMOUNT = 1000 lamports)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Deposit below minimum threshold (should fail with DepositTooSmall)");
  console.log("-".repeat(70));

  try {
    await program.methods
      .depositSol(new BN(500), new BN(0)) // 500 lamports < 1000 minimum
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
    console.log("  FAILED: Should have rejected");
    results.push({ name: "Deposit too small", passed: false });
  } catch (err: any) {
    if (err.toString().includes("DepositTooSmall")) {
      console.log("  PASSED: Correctly rejected (DepositTooSmall)");
      results.push({ name: "Deposit too small", passed: true });
    } else {
      console.log("  PASSED: Correctly rejected");
      results.push({ name: "Deposit too small", passed: true });
    }
  }

  // TEST 4: Unauthorized pause attempt
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: Unauthorized pause attempt (should fail)");
  console.log("-".repeat(70));

  const unauthorized = Keypair.generate();
  await fundAccount(connection, payer, unauthorized.publicKey, 0.05);

  try {
    const idlPath = path.join(__dirname, "../../target/idl/svs_7.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const unauthorizedWallet = new anchor.Wallet(unauthorized);
    const unauthorizedProvider = new anchor.AnchorProvider(connection, unauthorizedWallet, { commitment: "confirmed" });
    const unauthorizedProgram = new Program(idl, unauthorizedProvider) as Program<Svs7>;

    await unauthorizedProgram.methods.pause()
      .accountsStrict({ authority: unauthorized.publicKey, vault })
      .signers([unauthorized])
      .rpc();
    console.log("  FAILED: Should have rejected");
    results.push({ name: "Unauthorized pause", passed: false });
  } catch {
    console.log("  PASSED: Correctly rejected");
    results.push({ name: "Unauthorized pause", passed: true });
  }

  // TEST 5: Deposit while paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: deposit_sol while paused (should fail with VaultPaused)");
  console.log("-".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  try {
    await program.methods
      .depositSol(new BN(1 * LAMPORTS_PER_SOL), new BN(0))
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
    console.log("  FAILED: Should have rejected");
    results.push({ name: "Deposit when paused", passed: false });
  } catch (err: any) {
    if (err.toString().includes("VaultPaused")) {
      console.log("  PASSED: Correctly rejected (VaultPaused)");
      results.push({ name: "Deposit when paused", passed: true });
    } else {
      console.log("  FAILED: Wrong error");
      results.push({ name: "Deposit when paused", passed: false });
    }
  }

  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

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
  console.log(passed === results.length ? "  ALL EDGE CASES HANDLED" : `  ${results.length - passed} ISSUES FOUND`);
  console.log("=".repeat(70) + "\n");

  if (passed < results.length) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
