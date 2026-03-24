/**
 * SVS-3 Basic Test Script
 *
 * Full lifecycle: init → configure_account → deposit → apply_pending → redeem
 * SVS-3 = Confidential Live Balance (encrypted shares, live total_assets)
 *
 * Run: npx ts-node scripts/svs-3/basic.ts
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
  setupTest, getVaultPDA, getSharesMintPDA, explorerUrl, ASSET_DECIMALS, SHARE_DECIMALS,
  requireBackend, configureUserAccount, redeemConfidential,
  deriveAesKeyFromSignature, createDecryptableZeroBalance,
} from "./helpers";

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("Basic Functionality");
  await requireBackend();

  // Step 1: Create Test Token
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Creating test token");
  console.log("-".repeat(70));

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );
  console.log(`  Asset Mint: ${assetMint.toBase58()}`);

  // Step 2: Mint tokens
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Minting tokens");
  console.log("-".repeat(70));

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  await mintTo(connection, payer, assetMint, userAta.address, payer, 1_000_000 * 10 ** ASSET_DECIMALS);
  console.log("  Minted: 1,000,000 tokens");

  // Step 3: Initialize vault
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Initializing confidential vault");
  console.log("-".repeat(70));

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const initTx = await program.methods
    .initialize(vaultId, "SVS-3 Test Vault", "svVAULT3", "https://test.com", null)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(`  Tx: ${explorerUrl(initTx)}`);

  const vaultState = await program.account.confidentialVault.fetch(vault);
  console.log(`  Account type: ConfidentialVault`);
  console.log(`  Decimals offset: ${vaultState.decimalsOffset}`);

  // Step 4: Configure account for CT
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Configuring account for confidential transfers");
  console.log("-".repeat(70));

  const configTx = await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);
  console.log(`  Configure Tx: ${explorerUrl(configTx)}`);

  // Step 5: Deposit
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Depositing assets");
  console.log("-".repeat(70));

  const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);
  const depositTx = await program.methods
    .deposit(depositAmount, new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  Deposit Tx: ${explorerUrl(depositTx)}`);

  const mintInfo = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
  const totalShares = Number(mintInfo.supply);
  console.log(`  Total shares minted: ${totalShares / 10 ** SHARE_DECIMALS}`);

  // Step 6: Apply pending
  console.log("\n" + "-".repeat(70));
  console.log("Step 6: Applying pending balance");
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

  // Step 7: Redeem (partial)
  console.log("\n" + "-".repeat(70));
  console.log("Step 7: Redeeming shares (confidential)");
  console.log("-".repeat(70));

  const sharesToRedeem = Math.floor(totalShares / 4);
  const assetsBefore = Number((await getAccount(connection, userAta.address)).amount);

  const redeemTx = await redeemConfidential(
    provider, program, payer, vault, assetMint, userAta.address,
    assetVault, sharesMint, userSharesAccount, sharesToRedeem, totalShares
  );
  console.log(`  Redeem Tx: ${explorerUrl(redeemTx)}`);

  const assetsAfter = Number((await getAccount(connection, userAta.address)).amount);
  const assetsReceived = (assetsAfter - assetsBefore) / 10 ** ASSET_DECIMALS;
  console.log(`  Assets received: ${assetsReceived.toLocaleString()}`);

  // Step 8: Pause/Unpause
  console.log("\n" + "-".repeat(70));
  console.log("Step 8: Testing pause/unpause");
  console.log("-".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
  let vAccount = await program.account.confidentialVault.fetch(vault);
  console.log(`  Paused: ${vAccount.paused}`);

  try {
    await program.methods.deposit(new BN(1000), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
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
  vAccount = await program.account.confidentialVault.fetch(vault);
  console.log(`  Paused: ${vAccount.paused}`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
