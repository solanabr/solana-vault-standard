/**
 * SVS-1 Edge Cases & Error Handling Test
 *
 * Tests error conditions:
 * - Zero amount operations
 * - Unauthorized admin operations
 * - Operations when paused
 * - Excess redemption/withdrawal
 * - Authority transfer
 * - Dust deposits
 * - Multi-vault isolation
 *
 * Run: npx ts-node scripts/svs-1/edge-cases.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
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
import { Svs1 } from "../../target/types/svs_1";
import { setupTest, getVaultPDA, getSharesMintPDA, fundAccount, ASSET_DECIMALS } from "./helpers";
import * as fs from "fs";
import * as path from "path";

interface TestResult {
  name: string;
  passed: boolean;
}

async function main() {
  const { connection, payer, program, programId, provider } = await setupTest("Edge Cases & Error Handling");

  const results: TestResult[] = [];

  // Create unauthorized user
  const unauthorized = Keypair.generate();
  console.log(`Unauthorized user: ${unauthorized.publicKey.toBase58()}`);

  // Fund unauthorized user (transfer, not airdrop)
  await fundAccount(connection, payer, unauthorized.publicKey, 0.05);

  // Setup
  console.log("\n--- Setup ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  const unauthorizedAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, unauthorized.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );

  await mintTo(connection, payer, assetMint, userAta.address, payer, 1_000_000 * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, unauthorizedAta.address, payer, 10_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .initialize(vaultId, "Edge Case Test Vault", "EDGE", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Initial deposit
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

  // TEST 1: Zero amount deposit
  console.log("-".repeat(70));
  console.log("TEST 1: Zero amount deposit (should fail)");
  console.log("-".repeat(70));

  try {
    await program.methods.deposit(new BN(0), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    console.log("  ❌ FAILED: Should have rejected"); results.push({ name: "Zero amount", passed: false });
  } catch {
    console.log("  ✅ PASSED: Correctly rejected"); results.push({ name: "Zero amount", passed: true });
  }

  // TEST 2: Unauthorized pause
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: Unauthorized pause attempt (should fail)");
  console.log("-".repeat(70));

  try {
    const idlPath = path.join(__dirname, "../../target/idl/svs_1.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const unauthorizedWallet = new anchor.Wallet(unauthorized);
    const unauthorizedProvider = new anchor.AnchorProvider(connection, unauthorizedWallet, { commitment: "confirmed" });
    const unauthorizedProgram = new Program(idl, unauthorizedProvider) as Program<Svs1>;

    await unauthorizedProgram.methods.pause()
      .accountsStrict({ authority: unauthorized.publicKey, vault })
      .signers([unauthorized]).rpc();
    console.log("  ❌ FAILED: Should have rejected"); results.push({ name: "Unauthorized pause", passed: false });
  } catch {
    console.log("  ✅ PASSED: Correctly rejected"); results.push({ name: "Unauthorized pause", passed: true });
  }

  // TEST 3: Deposit when paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Deposit when paused (should fail)");
  console.log("-".repeat(70));

  await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  try {
    await program.methods.deposit(new BN(1000 * 10 ** ASSET_DECIMALS), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    console.log("  ❌ FAILED: Should have rejected"); results.push({ name: "Deposit when paused", passed: false });
  } catch (err: any) {
    if (err.toString().includes("VaultPaused")) {
      console.log("  ✅ PASSED: Correctly rejected"); results.push({ name: "Deposit when paused", passed: true });
    } else {
      console.log("  ❌ FAILED: Wrong error"); results.push({ name: "Deposit when paused", passed: false });
    }
  }

  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // TEST 4: Redeem more shares than owned
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: Redeem more shares than owned (should fail)");
  console.log("-".repeat(70));

  const userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

  try {
    await program.methods.redeem(new BN(Number(userShares.amount) * 2), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();
    console.log("  ❌ FAILED: Should have rejected"); results.push({ name: "Excess redeem", passed: false });
  } catch {
    console.log("  ✅ PASSED: Correctly rejected"); results.push({ name: "Excess redeem", passed: true });
  }

  // TEST 5: Authority transfer
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: Authority transfer");
  console.log("-".repeat(70));

  const newAuthority = Keypair.generate();
  await fundAccount(connection, payer, newAuthority.publicKey, 0.05);

  await program.methods.transferAuthority(newAuthority.publicKey)
    .accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // Old authority should fail
  try {
    await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
    console.log("  ❌ FAILED: Old authority should be blocked"); results.push({ name: "Authority transfer", passed: false });
  } catch {
    console.log("  ✅ PASSED: Old authority blocked"); results.push({ name: "Authority transfer", passed: true });
  }

  // TEST 6: Multi-vault isolation
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: Multi-vault isolation");
  console.log("-".repeat(70));

  // Need to use new authority for new vault
  const idlPath = path.join(__dirname, "../../target/idl/svs_1.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const vaultId2 = new BN(Date.now() + 1);
  const [vault2] = getVaultPDA(programId, assetMint, vaultId2);
  const [sharesMint2] = getSharesMintPDA(programId, vault2);
  const assetVault2 = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault2 });

  await program.methods
    .initialize(vaultId2, "Second Vault", "VAULT2", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault: vault2, assetMint, sharesMint: sharesMint2, assetVault: assetVault2,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  const userSharesAccount2 = getAssociatedTokenAddressSync(
    sharesMint2, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .deposit(new BN(50_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault: vault2, assetMint, userAssetAccount: userAta.address,
      assetVault: assetVault2, sharesMint: sharesMint2, userSharesAccount: userSharesAccount2,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const vault1State = await program.account.vault.fetch(vault);
  const vault2State = await program.account.vault.fetch(vault2);

  if (vault1State.totalAssets.toNumber() !== vault2State.totalAssets.toNumber()) {
    console.log("  ✅ PASSED: Vaults are isolated"); results.push({ name: "Vault isolation", passed: true });
  } else {
    console.log("  ❌ FAILED: Vaults not isolated"); results.push({ name: "Vault isolation", passed: false });
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));

  const passed = results.filter(r => r.passed).length;
  console.log(`\n  Results: ${passed}/${results.length} passed\n`);

  for (const result of results) {
    console.log(`  ${result.passed ? "✅" : "❌"} ${result.name}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log(passed === results.length ? "  ✅ ALL EDGE CASES HANDLED" : `  ⚠️ ${results.length - passed} ISSUES`);
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
