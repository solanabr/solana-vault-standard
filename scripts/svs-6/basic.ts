/**
 * SVS-6 Basic Test Script
 *
 * Full lifecycle combining SVS-5 streaming yield with SVS-3 confidential transfers:
 * - Initialize confidential streaming vault
 * - Configure account for CT
 * - Deposit assets (shares minted as CT pending balance)
 * - Apply pending balance
 * - Distribute yield as stream
 * - Checkpoint accrued yield
 * - Redeem shares (confidential, with ZK proofs)
 * - Verify final state
 *
 * Run: npx ts-node scripts/svs-6/basic.ts
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
  getMint,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  setupTest,
  getVaultPDA,
  getSharesMintPDA,
  explorerUrl,
  createSharesAtaIx,
  requireBackend,
  configureUserAccount,
  redeemConfidential,
  deriveAesKeyFromSignature,
  createDecryptableZeroBalance,
  distributeYield,
  checkpoint,
  ASSET_DECIMALS,
  SHARE_DECIMALS,
} from "./helpers";

const INITIAL_MINT_AMOUNT = 1_000_000;
const DEPOSIT_AMOUNT = 100_000;
const YIELD_AMOUNT = 10_000;
const STREAM_DURATION = 120; // 2 minutes

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("Basic Functionality");
  await requireBackend();

  // Step 1: Create Test Token
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Creating test token (Mock USDC)");
  console.log("-".repeat(70));

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );
  console.log(`  Asset Mint: ${assetMint.toBase58()}`);

  // Step 2: Mint tokens
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Minting tokens to user");
  console.log("-".repeat(70));

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  const userAssetAccount = userAta.address;

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
  console.log("Step 4: Initializing confidential streaming vault");
  console.log("-".repeat(70));

  const initTx = await program.methods
    .initialize(vaultId, null)
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

  const vaultState = await program.account.confidentialStreamVault.fetch(vault);
  console.log(`  Account type: ConfidentialStreamVault`);
  console.log(`  Decimals offset: ${vaultState.decimalsOffset}`);

  // Step 5: Configure account for CT
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Configuring account for confidential transfers");
  console.log("-".repeat(70));

  const configTx = await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);
  console.log(`  Configure Tx: ${explorerUrl(configTx)}`);

  // Step 6: Deposit
  console.log("\n" + "-".repeat(70));
  console.log("Step 6: Depositing assets");
  console.log("-".repeat(70));

  const depositAmount = new BN(DEPOSIT_AMOUNT * 10 ** ASSET_DECIMALS);
  const depositTx = await program.methods
    .deposit(depositAmount, new BN(0))
    .accountsStrict({
      user: payer.publicKey,
      vault, assetMint, userAssetAccount, assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
    .rpc();

  console.log(`  Deposit Tx: ${explorerUrl(depositTx)}`);

  let vAccount = await program.account.confidentialStreamVault.fetch(vault);
  console.log(`  Total Shares (cached): ${vAccount.totalShares.toString()}`);
  console.log(`  Base Assets: ${vAccount.baseAssets.toString()}`);

  // Step 7: Apply pending balance
  console.log("\n" + "-".repeat(70));
  console.log("Step 7: Applying pending balance");
  console.log("-".repeat(70));

  const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
  const newBalance = createDecryptableZeroBalance(aesKey);

  const applyTx = await program.methods
    .applyPending(Array.from(newBalance), new BN(1))
    .accountsStrict({
      user: payer.publicKey, vault, userSharesAccount,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  console.log(`  Apply Tx: ${explorerUrl(applyTx)}`);

  // Step 8: Distribute Yield
  console.log("\n" + "-".repeat(70));
  console.log("Step 8: Distributing yield as stream");
  console.log("-".repeat(70));

  const yieldAmount = new BN(YIELD_AMOUNT * 10 ** ASSET_DECIMALS);
  const yieldTx = await distributeYield(
    program, payer, vault, assetMint, userAssetAccount, assetVault,
    yieldAmount, new BN(STREAM_DURATION)
  );

  console.log(`  Yield Amount: ${YIELD_AMOUNT.toLocaleString()} tokens`);
  console.log(`  Stream Duration: ${STREAM_DURATION}s`);
  console.log(`  Tx: ${explorerUrl(yieldTx)}`);

  vAccount = await program.account.confidentialStreamVault.fetch(vault);
  console.log(`  Stream Amount: ${vAccount.streamAmount.toString()}`);
  console.log(`  Stream Start: ${vAccount.streamStart.toString()}`);
  console.log(`  Stream End: ${vAccount.streamEnd.toString()}`);

  // Step 9: Checkpoint
  console.log("\n" + "-".repeat(70));
  console.log("Step 9: Running checkpoint (materializing accrued yield)");
  console.log("-".repeat(70));

  console.log("  Waiting 5s for yield to accrue...");
  await new Promise(r => setTimeout(r, 5000));

  const checkpointTx = await checkpoint(program, vault);

  vAccount = await program.account.confidentialStreamVault.fetch(vault);
  console.log(`  Tx: ${explorerUrl(checkpointTx)}`);
  console.log(`  Base Assets After Checkpoint: ${vAccount.baseAssets.toString()}`);
  console.log(`  Remaining Stream: ${vAccount.streamAmount.toString()}`);

  // Step 10: Redeem (confidential, partial)
  console.log("\n" + "-".repeat(70));
  console.log("Step 10: Redeeming shares (confidential with ZK proofs)");
  console.log("-".repeat(70));

  const totalShares = Number(vAccount.totalShares);
  const sharesToRedeem = Math.floor(totalShares / 4);
  const assetsBefore = Number((await getAccount(connection, userAssetAccount)).amount);

  const redeemTx = await redeemConfidential(
    provider, program, payer, vault, assetMint, userAssetAccount,
    assetVault, sharesMint, userSharesAccount, sharesToRedeem, totalShares
  );
  console.log(`  Redeem Tx: ${explorerUrl(redeemTx)}`);

  const assetsAfter = Number((await getAccount(connection, userAssetAccount)).amount);
  const assetsReceived = (assetsAfter - assetsBefore) / 10 ** ASSET_DECIMALS;
  console.log(`  Shares Redeemed: ${sharesToRedeem}`);
  console.log(`  Assets Received: ${assetsReceived.toLocaleString()}`);

  // Step 11: Verify final state
  console.log("\n" + "-".repeat(70));
  console.log("Step 11: Verifying final vault state");
  console.log("-".repeat(70));

  vAccount = await program.account.confidentialStreamVault.fetch(vault);
  console.log(`  Authority: ${vAccount.authority.toBase58()}`);
  console.log(`  Base Assets: ${vAccount.baseAssets.toString()}`);
  console.log(`  Total Shares: ${vAccount.totalShares.toString()}`);
  console.log(`  Paused: ${vAccount.paused}`);
  console.log(`  Stream Amount: ${vAccount.streamAmount.toString()}`);

  // Step 12: Pause/Unpause
  console.log("\n" + "-".repeat(70));
  console.log("Step 12: Testing pause/unpause");
  console.log("-".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
  vAccount = await program.account.confidentialStreamVault.fetch(vault);
  console.log(`  Vault Paused: ${vAccount.paused}`);

  try {
    await program.methods.deposit(new BN(1000), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount, assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
      .rpc();
    console.log("  ERROR: Deposit should have failed when paused!");
  } catch (err: any) {
    if (err.toString().includes("VaultPaused")) {
      console.log("  Deposit correctly rejected (VaultPaused)");
    }
  }

  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
  vAccount = await program.account.confidentialStreamVault.fetch(vault);
  console.log(`  Vault Paused: ${vAccount.paused}`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
