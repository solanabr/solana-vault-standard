/**
 * SVS-9 Deposit Script
 *
 * Deposits assets into the SVS-9 Allocator Vault and receives shares.
 * Supports slippage protection via min_shares_out.
 *
 * Run: npx ts-node scripts/svs-9/deposit.ts
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
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import {
  setupTest,
  getAllocatorVaultPDA,
  getChildAllocationPDA,
  explorerUrl,
  accountUrl,
  ASSET_DECIMALS,
} from "./helpers";

const INITIAL_MINT_AMOUNT = 1_000_000; // 1M tokens
const DEPOSIT_AMOUNT = 100_000; // 100k tokens

async function main() {
  const { connection, payer, program, programId } = await setupTest("Deposit");

  // ─── Step 1: Create Asset Mint (Mock USDC) ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Creating test token (Mock USDC)");
  console.log("-".repeat(70));

  const assetMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    ASSET_DECIMALS,
    Keypair.generate(),
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log(`  Asset Mint: ${assetMint.toBase58()}`);

  // ─── Step 2: Mint tokens to user ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Minting tokens to user");
  console.log("-".repeat(70));

  const userAssetAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    assetMint,
    payer.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  await mintTo(
    connection,
    payer,
    assetMint,
    userAssetAta.address,
    payer.publicKey,
    INITIAL_MINT_AMOUNT * 10 ** ASSET_DECIMALS,
    [],
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log(`  Minted: ${INITIAL_MINT_AMOUNT.toLocaleString()} tokens`);

  // ─── Step 3: Initialize Allocator Vault ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Initializing SVS-9 Allocator Vault");
  console.log("-".repeat(70));

  const vaultId = new BN(Date.now());
  const idleBufferBps = 1000; // 10%
  const sharesMintKeypair = Keypair.generate();

  const [allocatorVault] = getAllocatorVaultPDA(programId, assetMint, vaultId);
  const idleVault = anchor.utils.token.associatedAddress({
    mint: assetMint,
    owner: allocatorVault,
  });

  const initTx = await program.methods
    .initialize(vaultId, idleBufferBps, 0)
    .accountsPartial({
      authority: payer.publicKey,
      curator: payer.publicKey,
      allocatorVault: allocatorVault,
      assetMint: assetMint,
      sharesMint: sharesMintKeypair.publicKey,
      idleVault: idleVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer, sharesMintKeypair])
    .rpc();

  console.log(`  Vault PDA: ${allocatorVault.toBase58()}`);
  console.log(`  Tx: ${initTx}`);
  console.log(`  Explorer: ${explorerUrl(initTx)}`);

  // ─── Step 4: Create User Shares ATA ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Creating user shares account (Token-2022)");
  console.log("-".repeat(70));

  const userSharesAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    sharesMintKeypair.publicKey,
    payer.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`  User Shares ATA: ${userSharesAta.address.toBase58()}`);

  // ─── Step 5: Deposit ───
  console.log("\n" + "-".repeat(70));
  console.log(`Step 5: Depositing ${DEPOSIT_AMOUNT.toLocaleString()} tokens`);
  console.log("-".repeat(70));

  const depositAmount = new BN(DEPOSIT_AMOUNT * 10 ** ASSET_DECIMALS);
  const minSharesOut = new BN(0); // No slippage protection for first deposit (1:1)

  const depositTx = await program.methods
    .deposit(depositAmount, minSharesOut)
    .accountsPartial({
      caller: payer.publicKey,
      owner: payer.publicKey,
      allocatorVault: allocatorVault,
      idleVault: idleVault,
      sharesMint: sharesMintKeypair.publicKey,
      callerAssetAccount: userAssetAta.address,
      ownerSharesAccount: userSharesAta.address,
      assetMint: assetMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([]) // No children yet on first deposit
    .signers([payer])
    .rpc();

  console.log(`  Tx: ${depositTx}`);
  console.log(`  Explorer: ${explorerUrl(depositTx)}`);

  // ─── Step 6: Verify Results ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 6: Verifying deposit results");
  console.log("-".repeat(70));

  const idleBalance = await connection.getTokenAccountBalance(idleVault);
  console.log(`  Idle Vault Balance: ${idleBalance.value.uiAmountString} tokens`);

  const sharesAccount = await getAccount(
    connection,
    userSharesAta.address,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`  Shares Received: ${Number(sharesAccount.amount) / 10 ** ASSET_DECIMALS}`);

  const assetBalance = await connection.getTokenAccountBalance(userAssetAta.address);
  console.log(`  Remaining Assets: ${assetBalance.value.uiAmountString} tokens`);

  // ─── Summary ───
  console.log("\n" + "=".repeat(70));
  console.log("  ✅ SVS-9 Deposit completed successfully!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
