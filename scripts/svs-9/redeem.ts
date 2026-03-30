/**
 * SVS-9 Redeem Script
 *
 * Burns allocator shares and receives underlying assets back from the idle vault.
 * Demonstrates the full deposit → redeem lifecycle with slippage protection.
 *
 * Run: npx ts-node scripts/svs-9/redeem.ts
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
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  setupTest,
  getAllocatorVaultPDA,
  explorerUrl,
  ASSET_DECIMALS,
} from "./helpers";

const INITIAL_MINT_AMOUNT = 1_000_000;
const DEPOSIT_AMOUNT = 100_000;
const REDEEM_PERCENTAGE = 0.5; // redeem 50% of shares

async function main() {
  const { connection, payer, program, programId } = await setupTest("Redeem");

  // ─── Setup: Create mint, vault, deposit ───
  console.log("\n" + "-".repeat(70));
  console.log("Setup: Creating vault and depositing assets");
  console.log("-".repeat(70));

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const userAssetAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );

  await mintTo(
    connection, payer, assetMint, userAssetAta.address, payer.publicKey,
    INITIAL_MINT_AMOUNT * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
  );

  const vaultId = new BN(Date.now());
  const sharesMintKeypair = Keypair.generate();
  const [allocatorVault] = getAllocatorVaultPDA(programId, assetMint, vaultId);
  const idleVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: allocatorVault });

  await program.methods
    .initialize(vaultId, 1000, 0)
    .accountsPartial({
      authority: payer.publicKey,
      curator: payer.publicKey,
      allocatorVault,
      assetMint,
      sharesMint: sharesMintKeypair.publicKey,
      idleVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer, sharesMintKeypair])
    .rpc();

  console.log(`  Vault initialized: ${allocatorVault.toBase58()}`);

  const userSharesAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, sharesMintKeypair.publicKey, payer.publicKey,
    false, undefined, undefined, TOKEN_2022_PROGRAM_ID
  );

  const depositAmount = new BN(DEPOSIT_AMOUNT * 10 ** ASSET_DECIMALS);
  await program.methods
    .deposit(depositAmount, new BN(0))
    .accountsPartial({
      caller: payer.publicKey,
      owner: payer.publicKey,
      allocatorVault,
      idleVault,
      sharesMint: sharesMintKeypair.publicKey,
      callerAssetAccount: userAssetAta.address,
      ownerSharesAccount: userSharesAta.address,
      assetMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([]) // No children at this point
    .signers([payer])
    .rpc();

  console.log(`  Deposited: ${DEPOSIT_AMOUNT.toLocaleString()} tokens`);

  // ─── Step 1: Read current shares balance ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Reading current shares balance");
  console.log("-".repeat(70));

  const sharesAccountBefore = await getAccount(
    connection, userSharesAta.address, undefined, TOKEN_2022_PROGRAM_ID
  );
  const totalShares = Number(sharesAccountBefore.amount);
  const sharesToRedeem = new BN(Math.floor(totalShares * REDEEM_PERCENTAGE));

  console.log(`  Total Shares: ${totalShares / 10 ** ASSET_DECIMALS}`);
  console.log(`  Redeeming: ${Number(sharesToRedeem) / 10 ** ASSET_DECIMALS} (${REDEEM_PERCENTAGE * 100}%)`);

  // ─── Step 2: Get balances before ───
  const assetBefore = await connection.getTokenAccountBalance(userAssetAta.address);
  const idleBefore = await connection.getTokenAccountBalance(idleVault);

  console.log(`  Assets Before Redeem: ${assetBefore.value.uiAmountString}`);
  console.log(`  Idle Vault Before: ${idleBefore.value.uiAmountString}`);

  // ─── Step 3: Execute Redeem ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Executing redeem");
  console.log("-".repeat(70));

  const redeemTx = await program.methods
    .redeem(sharesToRedeem, new BN(0)) // min_assets_out = 0
    .accountsPartial({
      caller: payer.publicKey,
      owner: payer.publicKey,
      allocatorVault,
      idleVault,
      sharesMint: sharesMintKeypair.publicKey,
      callerAssetAccount: userAssetAta.address,
      ownerSharesAccount: userSharesAta.address,
      assetMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .remainingAccounts([]) // No children; add child account metas here if allocated
    .signers([payer])
    .rpc();

  console.log(`  Tx: ${redeemTx}`);
  console.log(`  Explorer: ${explorerUrl(redeemTx)}`);

  // ─── Step 4: Verify Results ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Verifying redeem results");
  console.log("-".repeat(70));

  const sharesAccountAfter = await getAccount(
    connection, userSharesAta.address, undefined, TOKEN_2022_PROGRAM_ID
  );
  const assetAfter = await connection.getTokenAccountBalance(userAssetAta.address);
  const idleAfter = await connection.getTokenAccountBalance(idleVault);

  console.log(`  Shares Remaining: ${Number(sharesAccountAfter.amount) / 10 ** ASSET_DECIMALS}`);
  console.log(`  Assets After Redeem: ${assetAfter.value.uiAmountString}`);
  console.log(`  Idle Vault After: ${idleAfter.value.uiAmountString}`);

  const assetsReceived = Number(assetAfter.value.amount) - Number(assetBefore.value.amount);
  console.log(`  Assets Received: ${assetsReceived / 10 ** ASSET_DECIMALS}`);

  // ─── Step 5: Test Slippage Protection ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Testing slippage protection on redeem");
  console.log("-".repeat(70));

  const remainingShares = new BN(sharesAccountAfter.amount.toString());
  const unreasonableMinAssets = new BN(999_999 * 10 ** ASSET_DECIMALS);

  try {
    await program.methods
      .redeem(remainingShares, unreasonableMinAssets)
      .accountsPartial({
        caller: payer.publicKey,
        owner: payer.publicKey,
        allocatorVault,
        idleVault,
        sharesMint: sharesMintKeypair.publicKey,
        callerAssetAccount: userAssetAta.address,
        ownerSharesAccount: userSharesAta.address,
        assetMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts([]) // No children
      .signers([payer])
      .rpc();
    console.log("  ❌ ERROR: Redeem should have failed with SlippageExceeded!");
  } catch (err: any) {
    if (err.toString().includes("SlippageExceeded")) {
      console.log("  ✅ Slippage protection working: redeem correctly rejected");
    } else {
      console.log(`  ⚠ Unexpected error: ${err.message}`);
    }
  }

  // ─── Summary ───
  console.log("\n" + "=".repeat(70));
  console.log("  ✅ SVS-9 Redeem completed successfully!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
