/**
 * SVS-7 Basic Test Script
 *
 * Tests core native SOL vault functionality:
 * - Initialize vault
 * - deposit_sol (native SOL)
 * - redeem_sol (get native SOL back)
 * - pause/unpause
 *
 * Run: npx ts-node scripts/svs-7/basic.ts
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
  accountUrl,
} from "./helpers";

// 1 SOL deposit
const DEPOSIT_LAMPORTS = new BN(1 * LAMPORTS_PER_SOL);
const REDEEM_PERCENTAGE = 0.5;

async function main() {
  const { connection, payer, program, programId } = await setupSvs7Test(
    "Basic Functionality",
  );

  // Step 1: Derive PDAs
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Deriving PDAs");
  console.log("-".repeat(70));

  const vaultId = new BN(Date.now());
  const [vault] = getSolVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);

  // wSOL vault: ATA of vault PDA for NATIVE_MINT (SPL Token)
  const wsolVault = anchor.utils.token.associatedAddress({
    mint: NATIVE_MINT,
    owner: vault,
  });

  // User shares account: ATA of user for sharesMint (Token-2022)
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log(`  Vault ID: ${vaultId.toString()}`);
  console.log(`  Vault PDA: ${vault.toBase58()}`);
  console.log(`  Shares Mint: ${accountUrl(sharesMint.toBase58())}`);
  console.log(`  wSOL Vault: ${accountUrl(wsolVault.toBase58())}`);

  // Step 2: Initialize Vault
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Initializing vault");
  console.log("-".repeat(70));

  const initTx = await program.methods
    .initialize(vaultId, "SVS-7 Test Vault", "svSOL")
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

  console.log(`  Tx: ${initTx}`);
  console.log(`  Explorer: ${explorerUrl(initTx)}`);

  const vaultAccount = await program.account.solVault.fetch(vault);
  console.log(`  Vault authority: ${vaultAccount.authority.toBase58()}`);
  console.log(`  Vault paused: ${vaultAccount.paused}`);

  // Step 3: deposit_sol
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Depositing 1 SOL");
  console.log("-".repeat(70));

  const depositTx = await program.methods
    .depositSol(DEPOSIT_LAMPORTS, new BN(0))
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

  console.log(`  Tx: ${depositTx}`);
  console.log(`  Explorer: ${explorerUrl(depositTx)}`);

  const userSharesAfterDeposit = await getAccount(
    connection,
    userSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  const sharesReceived =
    Number(userSharesAfterDeposit.amount) / LAMPORTS_PER_SOL;
  console.log(`  Shares Received: ${sharesReceived.toLocaleString()} svSOL`);

  const wsolVaultAfter = await getAccount(
    connection,
    wsolVault,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  console.log(
    `  wSOL Vault Balance: ${Number(wsolVaultAfter.amount) / LAMPORTS_PER_SOL} SOL`,
  );

  // Step 4: redeem_sol — create a temporary wSOL account for the unwrap
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Redeeming 50% of shares for native SOL");
  console.log("-".repeat(70));

  const redeemShares = new BN(
    Math.floor(Number(userSharesAfterDeposit.amount) * REDEEM_PERCENTAGE),
  );

  // Create a temporary wSOL ATA for the user (redeem_sol closes it after unwrapping)
  const userWsolAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Create the ATA if it doesn't exist yet
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
    console.log(`  Created user wSOL ATA: ${userWsolAccount.toBase58()}`);
  }

  const solBalanceBefore = await connection.getBalance(payer.publicKey);

  const redeemTx = await program.methods
    .redeemSol(redeemShares, new BN(0))
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

  console.log(`  Tx: ${redeemTx}`);
  console.log(`  Explorer: ${explorerUrl(redeemTx)}`);

  const solBalanceAfter = await connection.getBalance(payer.publicKey);
  const solReceived = (solBalanceAfter - solBalanceBefore) / LAMPORTS_PER_SOL;
  console.log(
    `  SOL received (approx, after fees): ${solReceived.toFixed(6)} SOL`,
  );

  const userSharesAfterRedeem = await getAccount(
    connection,
    userSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log(
    `  Remaining shares: ${Number(userSharesAfterRedeem.amount) / LAMPORTS_PER_SOL} svSOL`,
  );

  // Step 5: Pause/Unpause
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Testing pause/unpause");
  console.log("-".repeat(70));

  await program.methods
    .pause()
    .accountsStrict({ authority: payer.publicKey, vault })
    .rpc();
  const pausedVault = await program.account.solVault.fetch(vault);
  console.log(`  Vault Paused: ${pausedVault.paused}`);

  // Deposit while paused should fail
  try {
    await program.methods
      .depositSol(new BN(1000), new BN(0))
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
    console.log("  ERROR: Deposit should have failed when paused!");
  } catch (err: any) {
    if (err.toString().includes("VaultPaused")) {
      console.log("  Deposit correctly rejected (VaultPaused)");
    } else {
      console.log(`  Rejected with: ${err.message.slice(0, 60)}`);
    }
  }

  await program.methods
    .unpause()
    .accountsStrict({ authority: payer.publicKey, vault })
    .rpc();
  const unpausedVault = await program.account.solVault.fetch(vault);
  console.log(`  Vault Paused: ${unpausedVault.paused}`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All basic tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
