/**
 * SVS-5 Withdraw & Mint During Active Stream Test
 *
 * Tests withdraw() and mint() during active yield streaming:
 * - mint(shares, maxAssetsIn) mid-stream
 * - withdraw(assets, maxSharesIn) mid-stream
 * - Verify checkpoint happens correctly on entry/exit
 *
 * Run: npx ts-node scripts/svs-5/withdraw-mint.ts
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
import { setupTest, getVaultPDA, getSharesMintPDA, createSharesAtaIx, ASSET_DECIMALS, SHARE_DECIMALS } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("Withdraw & Mint (Streaming)");

  let passed = 0;
  let failed = 0;

  // Setup
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  await mintTo(connection, payer, assetMint, userAta.address, payer, 1_000_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .initialize(vaultId)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Seed deposit
  await program.methods
    .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
    .rpc();

  // Start yield stream
  await program.methods
    .distributeYield(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(120))
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint,
      authorityAssetAccount: userAta.address, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("  Setup complete: 100K deposited + 10K stream over 120s\n");

  // Wait for some yield to accrue
  console.log("  Waiting 5s for yield to accrue...\n");
  await new Promise(r => setTimeout(r, 5000));

  // ============================================================================
  // TEST 1: mint() mid-stream — specify shares, cap assets
  // ============================================================================
  console.log("-".repeat(70));
  console.log("TEST 1: mint() mid-stream");
  console.log("-".repeat(70));

  const sharesBefore1 = Number((await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID)).amount);
  const assetsBefore1 = Number((await getAccount(connection, userAta.address)).amount);

  const sharesToMint = new BN(10_000 * 10 ** SHARE_DECIMALS);
  const maxAssetsIn = new BN(15_000 * 10 ** ASSET_DECIMALS);

  try {
    await program.methods
      .mint(sharesToMint, maxAssetsIn)
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
      .rpc();

    const sharesAfter1 = Number((await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID)).amount);
    const assetsAfter1 = Number((await getAccount(connection, userAta.address)).amount);

    const sharesGained = sharesAfter1 - sharesBefore1;
    const assetsSpent = assetsBefore1 - assetsAfter1;

    console.log(`  Shares minted: ${sharesGained / 10 ** SHARE_DECIMALS}`);
    console.log(`  Assets spent:  ${assetsSpent / 10 ** ASSET_DECIMALS}`);

    if (sharesGained > 0 && assetsSpent > 0 && assetsSpent <= maxAssetsIn.toNumber()) {
      console.log("  ✅ PASSED"); passed++;
    } else {
      console.log("  ❌ FAILED: Unexpected amounts"); failed++;
    }
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); failed++;
  }

  // ============================================================================
  // TEST 2: withdraw() mid-stream — specify assets, cap shares
  // ============================================================================
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: withdraw() mid-stream");
  console.log("-".repeat(70));

  const sharesBefore3 = Number((await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID)).amount);
  const assetsBefore3 = Number((await getAccount(connection, userAta.address)).amount);

  const assetsToWithdraw = new BN(5_000 * 10 ** ASSET_DECIMALS);
  const maxSharesIn = new BN(10_000 * 10 ** SHARE_DECIMALS);

  try {
    await program.methods
      .withdraw(assetsToWithdraw, maxSharesIn)
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const sharesAfter3 = Number((await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID)).amount);
    const assetsAfter3 = Number((await getAccount(connection, userAta.address)).amount);

    const sharesBurned = sharesBefore3 - sharesAfter3;
    const assetsReceived = assetsAfter3 - assetsBefore3;

    console.log(`  Assets received: ${assetsReceived / 10 ** ASSET_DECIMALS}`);
    console.log(`  Shares burned:   ${sharesBurned / 10 ** SHARE_DECIMALS}`);

    if (assetsReceived === assetsToWithdraw.toNumber() && sharesBurned > 0 && sharesBurned <= maxSharesIn.toNumber()) {
      console.log("  ✅ PASSED"); passed++;
    } else {
      console.log("  ❌ FAILED: Unexpected amounts"); failed++;
    }
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`); failed++;
  }

  // ============================================================================
  // TEST 3: Vault state consistency after mid-stream operations
  // ============================================================================
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Vault state consistency after mid-stream operations");
  console.log("-".repeat(70));

  const vaultState = await program.account.streamVault.fetch(vault);
  const vaultBalance = await getAccount(connection, assetVault, undefined, TOKEN_PROGRAM_ID);
  const mintInfo = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);

  const totalAssets = Number(vaultBalance.amount);
  const totalShares = Number(mintInfo.supply);
  const baseAssets = vaultState.baseAssets.toNumber();
  const streamAmount = vaultState.streamAmount.toNumber();

  console.log(`  Vault token balance: ${totalAssets / 10 ** ASSET_DECIMALS}`);
  console.log(`  base_assets: ${baseAssets / 10 ** ASSET_DECIMALS}`);
  console.log(`  stream_amount: ${streamAmount / 10 ** ASSET_DECIMALS}`);
  console.log(`  total shares: ${totalShares / 10 ** SHARE_DECIMALS}`);

  // base_assets + stream_amount should be <= vault token balance
  if (baseAssets + streamAmount <= totalAssets && totalShares > 0) {
    console.log("  ✅ PASSED: Consistent state after mid-stream operations"); passed++;
  } else {
    console.log("  ❌ FAILED: Inconsistent state"); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Withdraw/Mint during stream ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
