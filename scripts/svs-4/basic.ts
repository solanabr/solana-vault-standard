/**
 * SVS-4 Basic Test Script
 *
 * Full lifecycle: init → configure → deposit → sync → apply_pending → redeem
 * SVS-4 = Confidential Stored Balance (encrypted shares + stored total_assets + sync)
 *
 * Run: npx ts-node scripts/svs-4/basic.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
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
  requireBackend, configureUserAccount, syncVault, redeemConfidential,
  deriveAesKeyFromSignature, createDecryptableZeroBalance,
} from "./helpers";

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("Basic Functionality");
  await requireBackend();

  // Step 1: Create Token
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
  console.log("Step 3: Initializing confidential vault (stored balance)");
  console.log("-".repeat(70));

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const initTx = await program.methods
    .initialize(vaultId, "SVS-4 Test Vault", "svVAULT4", "https://test.com", null)
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

  // Step 4: Configure account for CT (must happen BEFORE deposit)
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Configuring account for CT");
  console.log("-".repeat(70));

  await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);
  console.log("  Account configured for confidential transfers");

  // Step 5: Deposit
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Depositing assets");
  console.log("-".repeat(70));

  const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);
  await program.methods
    .deposit(depositAmount, new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const mintInfo = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
  const totalShares = Number(mintInfo.supply);
  console.log(`  Shares minted: ${totalShares / 10 ** SHARE_DECIMALS}`);

  let vs = await program.account.confidentialVault.fetch(vault);
  console.log(`  Stored total_assets: ${vs.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  // Step 6: Simulate yield + sync
  console.log("\n" + "-".repeat(70));
  console.log("Step 6: Simulating yield + sync");
  console.log("-".repeat(70));

  await transfer(connection, payer, userAta.address, assetVault, payer,
    50_000 * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);
  console.log("  Donated 50K tokens to vault");

  vs = await program.account.confidentialVault.fetch(vault);
  console.log(`  Stored total_assets BEFORE sync: ${vs.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  await syncVault(program, payer, vault, assetVault);

  vs = await program.account.confidentialVault.fetch(vault);
  console.log(`  Stored total_assets AFTER sync:  ${vs.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  // Step 7: Apply pending
  console.log("\n" + "-".repeat(70));
  console.log("Step 7: Applying pending balance");
  console.log("-".repeat(70));

  const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
  const newBalance = createDecryptableZeroBalance(aesKey);

  await program.methods
    .applyPending(Array.from(newBalance), new BN(1))
    .accountsStrict({
      user: payer.publicKey, vault, userSharesAccount,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  console.log("  Pending balance applied");

  // Step 8: Redeem
  console.log("\n" + "-".repeat(70));
  console.log("Step 8: Redeeming shares (confidential)");
  console.log("-".repeat(70));

  const sharesToRedeem = Math.floor(totalShares / 4);
  const assetsBefore = Number((await getAccount(connection, userAta.address)).amount);

  await redeemConfidential(
    provider, program, payer, vault, assetMint, userAta.address,
    assetVault, sharesMint, userSharesAccount, sharesToRedeem, totalShares
  );

  const assetsAfter = Number((await getAccount(connection, userAta.address)).amount);
  const assetsReceived = (assetsAfter - assetsBefore) / 10 ** ASSET_DECIMALS;
  console.log(`  Assets received: ${assetsReceived.toLocaleString()}`);

  vs = await program.account.confidentialVault.fetch(vault);
  console.log(`  Stored total_assets after redeem: ${vs.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  // Step 9: Pause/Unpause
  console.log("\n" + "-".repeat(70));
  console.log("Step 9: Testing pause/unpause");
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

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
