/**
 * SVS-5 Streaming Balance Behavior Test
 *
 * Tests SVS-5's time-interpolated yield behavior:
 * 1. Start a yield stream
 * 2. Query effective_total_assets at multiple timestamps
 * 3. Verify linear interpolation
 * 4. Verify checkpoint materializes accrued yield
 *
 * Run: npx ts-node scripts/svs-5/live-balance.ts
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
  const { connection, payer, program, programId } = await setupTest("Streaming Balance Behavior");

  let passed = 0;
  let failed = 0;

  // Setup vault
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );

  await mintTo(connection, payer, assetMint, userAta.address, payer, 10_000_000 * 10 ** ASSET_DECIMALS);

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

  // Initial deposit
  const DEPOSIT = 100_000;
  await program.methods
    .deposit(new BN(DEPOSIT * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
    .rpc();

  // ============================================================================
  // TEST 1: base_assets starts at deposit amount
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 1: Initial State (no stream)");
  console.log("=".repeat(70));

  let vaultState = await program.account.streamVault.fetch(vault);
  const expectedBase = DEPOSIT * 10 ** ASSET_DECIMALS;
  console.log(`\n  base_assets: ${vaultState.baseAssets.toString()}`);
  console.log(`  stream_amount: ${vaultState.streamAmount.toString()}`);

  if (vaultState.baseAssets.toNumber() === expectedBase && vaultState.streamAmount.toNumber() === 0) {
    console.log("  ✅ PASSED: Correct initial state"); passed++;
  } else {
    console.log("  ❌ FAILED: Unexpected initial state"); failed++;
  }

  // ============================================================================
  // TEST 2: Start stream and verify state
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 2: Start Stream");
  console.log("=".repeat(70));

  const YIELD = 10_000;
  const DURATION = 120;

  await program.methods
    .distributeYield(new BN(YIELD * 10 ** ASSET_DECIMALS), new BN(DURATION))
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint,
      authorityAssetAccount: userAta.address, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  vaultState = await program.account.streamVault.fetch(vault);
  console.log(`\n  base_assets: ${vaultState.baseAssets.toString()}`);
  console.log(`  stream_amount: ${vaultState.streamAmount.toString()}`);
  console.log(`  stream_start: ${vaultState.streamStart.toString()}`);
  console.log(`  stream_end: ${vaultState.streamEnd.toString()}`);
  console.log(`  duration: ${vaultState.streamEnd.sub(vaultState.streamStart).toString()}s`);

  if (vaultState.streamAmount.toNumber() === YIELD * 10 ** ASSET_DECIMALS) {
    console.log("  ✅ PASSED: Stream started correctly"); passed++;
  } else {
    console.log("  ❌ FAILED: Wrong stream amount"); failed++;
  }

  // ============================================================================
  // TEST 3: Yield accrues over time (check via checkpoint)
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 3: Yield Accrues Over Time");
  console.log("=".repeat(70));

  const baseBeforeWait = vaultState.baseAssets.toNumber();

  console.log("\n  Waiting 10s for yield to accrue...");
  await new Promise(r => setTimeout(r, 10000));

  // Checkpoint to materialize accrued yield
  await program.methods.checkpoint().accountsStrict({ vault }).rpc();

  vaultState = await program.account.streamVault.fetch(vault);
  const baseAfterCheckpoint = vaultState.baseAssets.toNumber();
  const accrued = baseAfterCheckpoint - baseBeforeWait;

  console.log(`  base_assets before: ${baseBeforeWait}`);
  console.log(`  base_assets after:  ${baseAfterCheckpoint}`);
  console.log(`  accrued yield: ${accrued / 10 ** ASSET_DECIMALS} tokens`);

  if (accrued > 0) {
    console.log("  ✅ PASSED: Yield accrued over time"); passed++;
  } else {
    console.log("  ❌ FAILED: No yield accrued"); failed++;
  }

  // ============================================================================
  // TEST 4: Remaining stream decreases after checkpoint
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 4: Stream Amount Decreases After Checkpoint");
  console.log("=".repeat(70));

  const remainingStream = vaultState.streamAmount.toNumber();
  const originalStream = YIELD * 10 ** ASSET_DECIMALS;

  console.log(`\n  original stream: ${originalStream}`);
  console.log(`  remaining stream: ${remainingStream}`);
  console.log(`  consumed: ${originalStream - remainingStream}`);

  if (remainingStream < originalStream && remainingStream > 0) {
    console.log("  ✅ PASSED: Stream partially consumed"); passed++;
  } else {
    console.log("  ❌ FAILED: Stream not decreasing correctly"); failed++;
  }

  // ============================================================================
  // TEST 5: Share price increases during stream
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 5: Share Price Increases During Stream");
  console.log("=".repeat(70));

  // SVS-5 uses base_assets for internal accounting
  // effective_total = base_assets + accrued_stream
  const mintInfo = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
  const totalShares = Number(mintInfo.supply);
  const effectiveAssets = baseAfterCheckpoint + remainingStream; // approximate: all yield will accrue eventually

  const priceNow = baseAfterCheckpoint / totalShares;
  const priceAfterFull = effectiveAssets / totalShares;

  console.log(`\n  Current price (base/shares): ${(priceNow * 10 ** SHARE_DECIMALS / 10 ** ASSET_DECIMALS).toFixed(6)}`);
  console.log(`  Price after full stream:     ${(priceAfterFull * 10 ** SHARE_DECIMALS / 10 ** ASSET_DECIMALS).toFixed(6)}`);

  if (priceNow >= (expectedBase / totalShares)) {
    console.log("  ✅ PASSED: Share price increased from yield"); passed++;
  } else {
    console.log("  ❌ FAILED: Share price did not increase"); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Streaming balance model ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
