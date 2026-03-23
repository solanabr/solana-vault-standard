/**
 * SVS-4 Edge Cases Test
 *
 * Combined error conditions for confidential stored balance:
 * - Zero/below-minimum deposits
 * - Unauthorized operations (pause, sync)
 * - Paused vault
 * - Authority transfer
 *
 * Run: npx ts-node scripts/svs-4/edge-cases.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  setupTest, getVaultPDA, getSharesMintPDA, fundAccount, ASSET_DECIMALS,
  requireBackend, configureUserAccount,
} from "./helpers";

interface TestResult { name: string; passed: boolean; }

async function main() {
  const { connection, payer, provider, program, programId } = await setupTest("Edge Cases");
  await requireBackend();

  const results: TestResult[] = [];

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
    .initialize(vaultId, "Edge Case Test", "EDGE4", "https://test.com", null)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Configure for CT (creates ATA internally + sets up CT extension)
  await configureUserAccount(provider, program, payer, vault, sharesMint, userSharesAccount);

  await program.methods
    .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("  Setup complete\n");

  const unauthorized = Keypair.generate();
  await fundAccount(connection, payer, unauthorized.publicKey, 0.05);

  // TEST 1: Zero amount
  console.log("-".repeat(70));
  console.log("TEST 1: Zero amount deposit");
  console.log("-".repeat(70));
  try {
    await program.methods.deposit(new BN(0), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    console.log("  ❌ FAILED"); results.push({ name: "Zero amount", passed: false });
  } catch {
    console.log("  ✅ PASSED"); results.push({ name: "Zero amount", passed: true });
  }

  // TEST 2: Below minimum
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: Deposit below minimum (999)");
  console.log("-".repeat(70));
  try {
    await program.methods.deposit(new BN(999), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    console.log("  ❌ FAILED"); results.push({ name: "Below minimum", passed: false });
  } catch {
    console.log("  ✅ PASSED"); results.push({ name: "Below minimum", passed: true });
  }

  // TEST 3: Unauthorized pause
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Unauthorized pause");
  console.log("-".repeat(70));
  try {
    await program.methods.pause()
      .accountsStrict({ authority: unauthorized.publicKey, vault })
      .signers([unauthorized]).rpc();
    console.log("  ❌ FAILED"); results.push({ name: "Unauthorized pause", passed: false });
  } catch {
    console.log("  ✅ PASSED"); results.push({ name: "Unauthorized pause", passed: true });
  }

  // TEST 4: Unauthorized sync
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: Unauthorized sync");
  console.log("-".repeat(70));
  try {
    await program.methods.sync()
      .accountsStrict({ authority: unauthorized.publicKey, vault, assetVault })
      .signers([unauthorized]).rpc();
    console.log("  ❌ FAILED"); results.push({ name: "Unauthorized sync", passed: false });
  } catch {
    console.log("  ✅ PASSED"); results.push({ name: "Unauthorized sync", passed: true });
  }

  // TEST 5: Deposit when paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: Deposit when paused");
  console.log("-".repeat(70));
  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
  try {
    await program.methods.deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    console.log("  ❌ FAILED"); results.push({ name: "Deposit when paused", passed: false });
  } catch (err: any) {
    const msg = err.toString();
    if (msg.includes("VaultPaused")) {
      console.log("  ✅ PASSED (VaultPaused)"); results.push({ name: "Deposit when paused", passed: true });
    } else {
      console.log("  ✅ PASSED (rejected)"); results.push({ name: "Deposit when paused", passed: true });
    }
  }
  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // TEST 6: Authority transfer
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: Authority transfer");
  console.log("-".repeat(70));
  const newAuth = Keypair.generate();
  await fundAccount(connection, payer, newAuth.publicKey, 0.05);
  await program.methods.transferAuthority(newAuth.publicKey)
    .accountsStrict({ authority: payer.publicKey, vault }).rpc();
  try {
    await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
    console.log("  ❌ FAILED"); results.push({ name: "Authority transfer", passed: false });
  } catch {
    console.log("  ✅ PASSED: Old authority blocked"); results.push({ name: "Authority transfer", passed: true });
  }

  // Summary
  const passedCount = results.filter(r => r.passed).length;
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passedCount}/${results.length} passed`);
  console.log("=".repeat(70));
  for (const r of results) console.log(`  ${r.passed ? "✅" : "❌"} ${r.name}`);
  console.log("=".repeat(70) + "\n");

  if (passedCount < results.length) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
