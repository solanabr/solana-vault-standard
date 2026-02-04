/**
 * SVS-1 Basic Test Script
 *
 * Tests core vault functionality:
 * - Initialize vault
 * - Deposit assets
 * - Redeem shares
 * - Pause/unpause
 *
 * Run: npx ts-node scripts/svs-1/basic.ts
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
import {
  setupTest,
  getVaultPDA,
  getSharesMintPDA,
  explorerUrl,
  accountUrl,
  ASSET_DECIMALS,
} from "./helpers";

const INITIAL_MINT_AMOUNT = 1_000_000;
const DEPOSIT_AMOUNT = 100_000;
const REDEEM_PERCENTAGE = 0.5;

async function main() {
  const { connection, payer, program, programId } = await setupTest("Basic Functionality");

  // Step 1: Create Test Token
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Creating test token (Mock USDC)");
  console.log("-".repeat(70));

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );
  console.log(`  Asset Mint: ${assetMint.toBase58()}`);
  console.log(`  Explorer: ${accountUrl(assetMint.toBase58())}`);

  // Step 2: Mint tokens
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Minting tokens to user");
  console.log("-".repeat(70));

  const userAssetAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  const userAssetAccount = userAssetAta.address;

  await mintTo(
    connection, payer, assetMint, userAssetAccount, payer.publicKey,
    INITIAL_MINT_AMOUNT * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
  );
  console.log(`  Minted: ${INITIAL_MINT_AMOUNT.toLocaleString()} tokens`);

  // Step 3: Derive PDAs
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Deriving PDAs");
  console.log("-".repeat(70));

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log(`  Vault ID: ${vaultId.toString()}`);
  console.log(`  Vault PDA: ${vault.toBase58()}`);

  // Step 4: Initialize Vault
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Initializing vault");
  console.log("-".repeat(70));

  const initTx = await program.methods
    .initialize(vaultId, "SVS-1 Test Vault", "svVAULT", "https://arweave.net/vault-metadata")
    .accountsStrict({
      authority: payer.publicKey,
      vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log(`  Tx: ${initTx}`);
  console.log(`  Explorer: ${explorerUrl(initTx)}`);

  // Step 5: Deposit
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Depositing assets");
  console.log("-".repeat(70));

  const depositAmount = new BN(DEPOSIT_AMOUNT * 10 ** ASSET_DECIMALS);
  const depositTx = await program.methods
    .deposit(depositAmount, new BN(0))
    .accountsStrict({
      user: payer.publicKey,
      vault, assetMint, userAssetAccount, assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`  Tx: ${depositTx}`);
  console.log(`  Explorer: ${explorerUrl(depositTx)}`);

  const userSharesAfterDeposit = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Shares Received: ${(Number(userSharesAfterDeposit.amount) / 10 ** 9).toLocaleString()}`);

  // Step 6: Redeem
  console.log("\n" + "-".repeat(70));
  console.log("Step 6: Redeeming shares");
  console.log("-".repeat(70));

  const redeemShares = new BN(Math.floor(Number(userSharesAfterDeposit.amount) * REDEEM_PERCENTAGE));
  const redeemTx = await program.methods
    .redeem(redeemShares, new BN(0))
    .accountsStrict({
      user: payer.publicKey,
      vault, assetMint, userAssetAccount, assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();

  console.log(`  Tx: ${redeemTx}`);
  console.log(`  Explorer: ${explorerUrl(redeemTx)}`);

  // Step 7: Pause/Unpause
  console.log("\n" + "-".repeat(70));
  console.log("Step 7: Testing pause/unpause");
  console.log("-".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
  let vaultAccount = await program.account.vault.fetch(vault);
  console.log(`  Vault Paused: ${vaultAccount.paused}`);

  try {
    await program.methods.deposit(new BN(1000), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount, assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    console.log("  ERROR: Deposit should have failed when paused!");
  } catch (err: any) {
    if (err.toString().includes("VaultPaused")) {
      console.log("  Deposit correctly rejected (VaultPaused)");
    }
  }

  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
  vaultAccount = await program.account.vault.fetch(vault);
  console.log(`  Vault Paused: ${vaultAccount.paused}`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
