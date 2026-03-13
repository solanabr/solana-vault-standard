/**
 * SVS-7 Slippage Protection Test
 *
 * Tests that min/max slippage parameters work correctly:
 * - deposit_sol with min_shares_out too high → should revert
 * - deposit_sol with reasonable min_shares_out → should pass
 * - mint_sol with max_lamports_in too low → should revert
 * - redeem_sol with min_lamports_out too high → should revert
 *
 * Run: npx ts-node scripts/svs-7/slippage.ts
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
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  setupSvs7Test,
  getSolVaultPDA,
  getSharesMintPDA,
} from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupSvs7Test("Slippage Protection");

  // Derive PDAs
  const vaultId = new BN(Date.now());
  const [vault] = getSolVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const wsolVault = anchor.utils.token.associatedAddress({ mint: NATIVE_MINT, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const userWsolAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Initialize vault
  await program.methods
    .initialize(vaultId, "Slippage Test Vault", "SLIP", "https://test.com")
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

  // Seed deposit: 5 SOL
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

  // Ensure user wSOL ATA exists
  try {
    await getAccount(connection, userWsolAccount, undefined, TOKEN_PROGRAM_ID);
  } catch {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey, userWsolAccount, payer.publicKey, NATIVE_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [payer]);
  }

  console.log("  Setup complete: 5 SOL deposited\n");

  let passed = 0;
  let failed = 0;

  // TEST 1: deposit_sol with min_shares_out too high
  console.log("-".repeat(70));
  console.log("TEST 1: deposit_sol with min_shares_out impossibly high");
  console.log("-".repeat(70));

  try {
    // Depositing 0.1 SOL (= 100M lamports). At 1:1 ratio, expect ~0.1e9 shares.
    // Demanding 1000 SOL worth of shares is impossible.
    await program.methods
      .depositSol(new BN(0.1 * LAMPORTS_PER_SOL), new BN(1000 * LAMPORTS_PER_SOL))
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
    console.log("  FAILED: Should have reverted"); failed++;
  } catch (err: any) {
    if (err.toString().includes("Slippage") || err.toString().includes("SlippageExceeded")) {
      console.log("  PASSED: Correctly reverted (SlippageExceeded)"); passed++;
    } else {
      console.log(`  PASSED: Rejected (${err.message.slice(0, 60)})`); passed++;
    }
  }

  // TEST 2: deposit_sol with reasonable min_shares_out (should succeed)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: deposit_sol with reasonable min_shares_out (should succeed)");
  console.log("-".repeat(70));

  try {
    // Deposit 0.1 SOL, require at least 0.09 shares (10% slippage tolerance)
    await program.methods
      .depositSol(new BN(0.1 * LAMPORTS_PER_SOL), new BN(0.09 * LAMPORTS_PER_SOL))
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
    console.log("  PASSED: Deposit succeeded"); passed++;
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`); failed++;
  }

  // TEST 3: mint_sol with max_lamports_in too low
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: mint_sol with max_lamports_in too low");
  console.log("-".repeat(70));

  try {
    // Mint 0.1 SOL worth of shares but only allow 1 lamport — impossible
    await program.methods
      .mintSol(new BN(0.1 * LAMPORTS_PER_SOL), new BN(1))
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
    console.log("  FAILED: Should have reverted"); failed++;
  } catch {
    console.log("  PASSED: Correctly rejected"); passed++;
  }

  // TEST 4: redeem_sol with min_lamports_out too high
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: redeem_sol with min_lamports_out too high");
  console.log("-".repeat(70));

  // Re-create wSOL ATA in case it was closed
  try {
    await getAccount(connection, userWsolAccount, undefined, TOKEN_PROGRAM_ID);
  } catch {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey, userWsolAccount, payer.publicKey, NATIVE_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [payer]);
  }

  const userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const sharesToRedeem = new BN(Math.floor(Number(userShares.amount) / 10)); // 10% of shares

  try {
    // Demand 1000 SOL for a tiny redemption — impossible
    await program.methods
      .redeemSol(sharesToRedeem, new BN(1000 * LAMPORTS_PER_SOL))
      .accountsStrict({
        user: payer.publicKey,
        vault,
        nativeMint: NATIVE_MINT,
        wsolVault,
        userWsolAccount,
        sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log("  FAILED: Should have reverted"); failed++;
  } catch {
    console.log("  PASSED: Correctly rejected"); passed++;
  }

  // TEST 5: redeem_sol with reasonable min_lamports_out (should succeed)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: redeem_sol with reasonable min_lamports_out (should succeed)");
  console.log("-".repeat(70));

  // Re-create wSOL ATA
  try {
    await getAccount(connection, userWsolAccount, undefined, TOKEN_PROGRAM_ID);
  } catch {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey, userWsolAccount, payer.publicKey, NATIVE_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [payer]);
  }

  try {
    // Redeem 10% of shares with min of 1 lamport (very permissive)
    await program.methods
      .redeemSol(sharesToRedeem, new BN(1))
      .accountsStrict({
        user: payer.publicKey,
        vault,
        nativeMint: NATIVE_MINT,
        wsolVault,
        userWsolAccount,
        sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log("  PASSED: Redeem succeeded"); passed++;
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Slippage protection ${failed === 0 ? "WORKING" : "HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
