/**
 * SVS-7 Withdraw & Mint Test
 *
 * Tests the exact-output operations:
 * - mint_sol (exact shares, pay SOL)
 * - withdraw_sol (exact lamports, burn shares)
 * - withdraw_wsol (exact lamports as wSOL)
 *
 * Run: npx ts-node scripts/svs-7/withdraw-mint.ts
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
  getMint,
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
  explorerUrl,
} from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupSvs7Test(
    "Withdraw & Mint (SOL)",
  );

  let passed = 0;
  let failed = 0;

  // Derive PDAs
  const vaultId = new BN(Date.now());
  const [vault] = getSolVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const wsolVault = anchor.utils.token.associatedAddress({
    mint: NATIVE_MINT,
    owner: vault,
  });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userWsolAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Initialize vault
  await program.methods
    .initialize(vaultId, "Withdraw Mint Test", "WDMT")
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

  console.log("  Setup complete: 5 SOL deposited\n");

  // Ensure user wSOL ATA exists for withdraw operations
  try {
    await getAccount(connection, userWsolAccount, undefined, TOKEN_PROGRAM_ID);
  } catch {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userWsolAccount,
        payer.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [payer]);
    console.log("  Created user wSOL ATA");
  }

  // ============================================================================
  // TEST 1: mint_sol happy path — specify exact shares, cap lamports
  // ============================================================================
  console.log("-".repeat(70));
  console.log(
    "TEST 1: mint_sol happy path (1 SOL worth of shares, generous cap)",
  );
  console.log("-".repeat(70));

  const sharesBefore1 = Number(
    (
      await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      )
    ).amount,
  );
  const solBefore1 = await connection.getBalance(payer.publicKey);

  const sharesToMint = new BN(1 * LAMPORTS_PER_SOL); // 1 svSOL
  const maxLamportsIn = new BN(2 * LAMPORTS_PER_SOL); // generous cap

  try {
    const mintTx = await program.methods
      .mintSol(sharesToMint, maxLamportsIn)
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

    const sharesAfter1 = Number(
      (
        await getAccount(
          connection,
          userSharesAccount,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        )
      ).amount,
    );
    const solAfter1 = await connection.getBalance(payer.publicKey);

    const sharesGained = sharesAfter1 - sharesBefore1;
    const lamportsSpent = solBefore1 - solAfter1;

    console.log(`  Shares minted: ${sharesGained / LAMPORTS_PER_SOL} svSOL`);
    console.log(
      `  SOL spent: ${lamportsSpent / LAMPORTS_PER_SOL} SOL (includes fees)`,
    );
    console.log(`  Explorer: ${explorerUrl(mintTx)}`);

    if (
      sharesGained > 0 &&
      lamportsSpent > 0 &&
      lamportsSpent <= maxLamportsIn.toNumber() + 5000
    ) {
      console.log("  PASSED");
      passed++;
    } else {
      console.log("  FAILED: Unexpected amounts");
      failed++;
    }
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`);
    failed++;
  }

  // ============================================================================
  // TEST 2: mint_sol with maxLamportsIn too low → should revert
  // ============================================================================
  console.log("\n" + "-".repeat(70));
  console.log(
    "TEST 2: mint_sol with maxLamportsIn too low (slippage protection)",
  );
  console.log("-".repeat(70));

  try {
    await program.methods
      .mintSol(new BN(1 * LAMPORTS_PER_SOL), new BN(1)) // 1 lamport cap — impossible
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
    console.log("  FAILED: Should have reverted");
    failed++;
  } catch {
    console.log("  PASSED: Correctly rejected");
    passed++;
  }

  // ============================================================================
  // TEST 3: withdraw_sol happy path — specify exact lamports, cap shares
  // ============================================================================
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: withdraw_sol happy path (0.5 SOL, generous share cap)");
  console.log("-".repeat(70));

  // Re-create user wSOL ATA (may have been closed if previous redeem_sol ran)
  try {
    await getAccount(connection, userWsolAccount, undefined, TOKEN_PROGRAM_ID);
  } catch {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userWsolAccount,
        payer.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [payer]);
  }

  const sharesBefore3 = Number(
    (
      await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      )
    ).amount,
  );
  const solBefore3 = await connection.getBalance(payer.publicKey);

  const lamportsToWithdraw = new BN(Math.floor(0.5 * LAMPORTS_PER_SOL));
  const maxSharesIn3 = new BN(2 * LAMPORTS_PER_SOL); // generous cap

  try {
    const withdrawTx = await program.methods
      .withdrawSol(lamportsToWithdraw, maxSharesIn3)
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

    const sharesAfter3 = Number(
      (
        await getAccount(
          connection,
          userSharesAccount,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        )
      ).amount,
    );
    const solAfter3 = await connection.getBalance(payer.publicKey);

    const sharesBurned = sharesBefore3 - sharesAfter3;

    console.log(`  Shares burned: ${sharesBurned / LAMPORTS_PER_SOL} svSOL`);
    console.log(`  Explorer: ${explorerUrl(withdrawTx)}`);

    if (sharesBurned > 0 && sharesBurned <= maxSharesIn3.toNumber()) {
      console.log("  PASSED");
      passed++;
    } else {
      console.log("  FAILED: Unexpected amounts");
      failed++;
    }
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`);
    failed++;
  }

  // ============================================================================
  // TEST 4: withdraw_sol with maxSharesIn too low → should revert
  // ============================================================================
  console.log("\n" + "-".repeat(70));
  console.log(
    "TEST 4: withdraw_sol with maxSharesIn too low (slippage protection)",
  );
  console.log("-".repeat(70));

  // Re-create ATA in case it was closed
  try {
    await getAccount(connection, userWsolAccount, undefined, TOKEN_PROGRAM_ID);
  } catch {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userWsolAccount,
        payer.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [payer]);
  }

  try {
    await program.methods
      .withdrawSol(new BN(0.5 * LAMPORTS_PER_SOL), new BN(1)) // 1 share cap — impossible
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
    console.log("  FAILED: Should have reverted");
    failed++;
  } catch {
    console.log("  PASSED: Correctly rejected");
    passed++;
  }

  // ============================================================================
  // TEST 5: withdraw_wsol happy path — get wSOL instead of native SOL
  // ============================================================================
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: withdraw_wsol happy path (0.5 SOL as wSOL)");
  console.log("-".repeat(70));

  const sharesBefore5 = Number(
    (
      await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      )
    ).amount,
  );

  // Ensure wSOL ATA exists for receiving wSOL
  try {
    await getAccount(connection, userWsolAccount, undefined, TOKEN_PROGRAM_ID);
  } catch {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userWsolAccount,
        payer.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [payer]);
  }

  const wsolBefore5 = await getAccount(
    connection,
    userWsolAccount,
    undefined,
    TOKEN_PROGRAM_ID,
  );

  try {
    const withdrawWsolTx = await program.methods
      .withdrawWsol(
        new BN(Math.floor(0.5 * LAMPORTS_PER_SOL)),
        new BN(2 * LAMPORTS_PER_SOL),
      )
      .accountsStrict({
        user: payer.publicKey,
        vault,
        nativeMint: NATIVE_MINT,
        userWsolAccount,
        wsolVault,
        sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const sharesAfter5 = Number(
      (
        await getAccount(
          connection,
          userSharesAccount,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        )
      ).amount,
    );
    const wsolAfter5 = await getAccount(
      connection,
      userWsolAccount,
      undefined,
      TOKEN_PROGRAM_ID,
    );

    const sharesBurned5 = sharesBefore5 - sharesAfter5;
    const wsolReceived5 =
      Number(wsolAfter5.amount) - Number(wsolBefore5.amount);

    console.log(`  Shares burned: ${sharesBurned5 / LAMPORTS_PER_SOL} svSOL`);
    console.log(`  wSOL received: ${wsolReceived5 / LAMPORTS_PER_SOL} wSOL`);
    console.log(`  Explorer: ${explorerUrl(withdrawWsolTx)}`);

    if (sharesBurned5 > 0 && wsolReceived5 > 0) {
      console.log("  PASSED");
      passed++;
    } else {
      console.log("  FAILED: Unexpected amounts");
      failed++;
    }
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`);
    failed++;
  }

  // ============================================================================
  // TEST 6: Consistency check
  // ============================================================================
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: Consistency — share price after mint/withdraw cycle");
  console.log("-".repeat(70));

  const wsolVaultState = await getAccount(
    connection,
    wsolVault,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  const mintInfo = await getMint(
    connection,
    sharesMint,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );

  const totalAssets = Number(wsolVaultState.amount);
  const totalShares = Number(mintInfo.supply);

  console.log(
    `  Total assets (wSOL vault): ${totalAssets / LAMPORTS_PER_SOL} SOL`,
  );
  console.log(`  Total shares supply: ${totalShares / LAMPORTS_PER_SOL} svSOL`);

  if (totalAssets > 0 && totalShares > 0) {
    const pricePerShare = totalAssets / totalShares;
    console.log(`  Price/share: ${pricePerShare.toFixed(9)}`);
    console.log("  PASSED: Consistent state");
    passed++;
  } else {
    console.log("  FAILED: Inconsistent state");
    failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(
    `  mint_sol/withdraw_sol/withdraw_wsol ${failed === 0 ? "ALL WORKING" : "HAS ISSUES"}`,
  );
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
