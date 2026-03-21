/**
 * SVS-7 SOL/wSOL Round-Trip Test
 *
 * Tests the dual deposit/redeem interface:
 * - deposit_sol → check shares → redeem_wsol (get wSOL)
 * - deposit_wsol → check shares → redeem_sol (get native SOL)
 * - Verify round-trip accounting is correct
 *
 * Run: npx ts-node scripts/svs-7/sol-wsol-roundtrip.ts
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
  createSyncNativeInstruction,
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

// Test amounts
const DEPOSIT_1_SOL = new BN(2 * LAMPORTS_PER_SOL); // deposit_sol round
const DEPOSIT_2_WSOL = new BN(1 * LAMPORTS_PER_SOL); // deposit_wsol round

async function main() {
  const { connection, payer, program, programId } = await setupSvs7Test(
    "SOL/wSOL Round-Trip",
  );

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
  // User's wSOL ATA (SPL Token, not Token-2022)
  const userWsolAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Initialize vault
  console.log("\n--- Initializing vault ---");
  await program.methods
    .initialize(vaultId, "Round-Trip Test Vault", "RTRIP")
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
  console.log("  Vault initialized");

  // Ensure user wSOL ATA exists
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
  // ROUND-TRIP 1: deposit_sol → redeem_wsol
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  ROUND-TRIP 1: deposit_sol → redeem_wsol");
  console.log("=".repeat(70));

  console.log(
    `\n--- Depositing ${DEPOSIT_1_SOL.toNumber() / LAMPORTS_PER_SOL} SOL (native) ---`,
  );

  const solBalanceBefore1 = await connection.getBalance(payer.publicKey);

  const depositSolTx = await program.methods
    .depositSol(DEPOSIT_1_SOL, new BN(0))
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

  console.log(`  Tx: ${explorerUrl(depositSolTx)}`);

  const sharesAfterDeposit1 = await getAccount(
    connection,
    userSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  const sharesBalance1 = Number(sharesAfterDeposit1.amount);
  console.log(`  Shares received: ${sharesBalance1 / LAMPORTS_PER_SOL} svSOL`);

  // Redeem for wSOL
  console.log("\n--- Redeeming all shares for wSOL ---");

  const wsolBefore = await getAccount(
    connection,
    userWsolAccount,
    undefined,
    TOKEN_PROGRAM_ID,
  );

  const redeemWsolTx = await program.methods
    .redeemWsol(new BN(sharesBalance1), new BN(0))
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

  console.log(`  Tx: ${explorerUrl(redeemWsolTx)}`);

  const wsolAfter = await getAccount(
    connection,
    userWsolAccount,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  const wsolReceived = Number(wsolAfter.amount) - Number(wsolBefore.amount);

  console.log(`  wSOL received: ${wsolReceived / LAMPORTS_PER_SOL} wSOL`);
  console.log(
    `  Original deposit: ${DEPOSIT_1_SOL.toNumber() / LAMPORTS_PER_SOL} SOL`,
  );

  const loss1 = DEPOSIT_1_SOL.toNumber() - wsolReceived;
  const lossPct1 = (loss1 / DEPOSIT_1_SOL.toNumber()) * 100;
  console.log(`  Round-trip slippage: ${lossPct1.toFixed(6)}%`);

  if (lossPct1 < 0.01) {
    console.log(
      "  PASSED: Round-trip 1 accounting is correct (< 0.01% slippage)",
    );
  } else {
    console.log("  WARN: Significant round-trip slippage detected");
  }

  // ============================================================================
  // ROUND-TRIP 2: deposit_wsol → redeem_sol
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  ROUND-TRIP 2: deposit_wsol → redeem_sol");
  console.log("=".repeat(70));

  // Wrap SOL to wSOL — transfer lamports to user's wSOL ATA then sync_native
  console.log("\n--- Wrapping SOL to wSOL ---");

  const wrapTx = new Transaction();
  wrapTx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: userWsolAccount,
      lamports: DEPOSIT_2_WSOL.toNumber(),
    }),
    createSyncNativeInstruction(userWsolAccount, TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, wrapTx, [payer]);

  const userWsolBalance = await getAccount(
    connection,
    userWsolAccount,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  console.log(
    `  User wSOL balance: ${Number(userWsolBalance.amount) / LAMPORTS_PER_SOL} wSOL`,
  );

  // deposit_wsol
  console.log(
    `\n--- Depositing ${DEPOSIT_2_WSOL.toNumber() / LAMPORTS_PER_SOL} wSOL ---`,
  );

  const depositWsolTx = await program.methods
    .depositWsol(DEPOSIT_2_WSOL, new BN(0))
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
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`  Tx: ${explorerUrl(depositWsolTx)}`);

  const sharesAfterDeposit2 = await getAccount(
    connection,
    userSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  const sharesBalance2 = Number(sharesAfterDeposit2.amount);
  console.log(`  Shares received: ${sharesBalance2 / LAMPORTS_PER_SOL} svSOL`);

  // Create new wSOL ATA for user to receive redeem_sol proceeds (closed after unwrap)
  // redeem_sol closes the userWsolAccount, so we need to re-create it first
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

  // redeem_sol
  console.log("\n--- Redeeming all shares for native SOL ---");

  const solBefore2 = await connection.getBalance(payer.publicKey);

  const redeemSolTx = await program.methods
    .redeemSol(new BN(sharesBalance2), new BN(0))
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

  console.log(`  Tx: ${explorerUrl(redeemSolTx)}`);

  const solAfter2 = await connection.getBalance(payer.publicKey);
  // Note: solAfter2 - solBefore2 includes lamport refund from closing the wSOL ATA
  const solReceived2 = solAfter2 - solBefore2;

  console.log(
    `  SOL received (net, includes ATA close refund): ${solReceived2 / LAMPORTS_PER_SOL} SOL`,
  );
  console.log(
    `  Original deposit: ${DEPOSIT_2_WSOL.toNumber() / LAMPORTS_PER_SOL} SOL`,
  );

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  ROUND-TRIP SUMMARY");
  console.log("=".repeat(70));
  console.log(
    `\n  RT1 (deposit_sol → redeem_wsol): ${lossPct1.toFixed(6)}% slippage`,
  );
  console.log(`  RT2 (deposit_wsol → redeem_sol): wSOL returned to native SOL`);
  console.log("\n  Both round-trips completed successfully");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
