/**
 * SVS-2 Edge Cases & Error Handling Test
 *
 * Same as SVS-1 edge cases + unauthorized sync attempt.
 *
 * Run: npx ts-node scripts/svs-2/edge-cases.ts
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
import { Svs2 } from "../../target/types/svs_2";
import { setupTest, getVaultPDA, getSharesMintPDA, fundAccount, fundAccounts, ASSET_DECIMALS } from "./helpers";
import * as fs from "fs";
import * as path from "path";

interface TestResult { name: string; passed: boolean; }

async function main() {
  const { connection, payer, program, programId, provider } = await setupTest("Edge Cases & Error Handling");

  const results: TestResult[] = [];
  const unauthorized = Keypair.generate();
  await fundAccount(connection, payer, unauthorized.publicKey, 0.05);

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
    .initialize(vaultId, "Edge Case Test", "EDGE2", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

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
    console.log("  ❌ FAILED"); results.push({ name: "Zero amount", passed: false });
  } catch {
    console.log("  ✅ PASSED"); results.push({ name: "Zero amount", passed: true });
  }

  // TEST 2: Unauthorized pause
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: Unauthorized pause attempt");
  console.log("-".repeat(70));
  try {
    const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../../target/idl/svs_2.json"), "utf-8"));
    const unauthProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(unauthorized), { commitment: "confirmed" });
    const unauthProgram = new Program(idl, unauthProvider) as Program<Svs2>;
    await unauthProgram.methods.pause().accountsStrict({ authority: unauthorized.publicKey, vault }).signers([unauthorized]).rpc();
    console.log("  ❌ FAILED"); results.push({ name: "Unauthorized pause", passed: false });
  } catch {
    console.log("  ✅ PASSED"); results.push({ name: "Unauthorized pause", passed: true });
  }

  // TEST 3: Deposit when paused
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Deposit when paused");
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
    console.log("  ❌ FAILED"); results.push({ name: "Deposit when paused", passed: false });
  } catch (err: any) {
    if (err.toString().includes("VaultPaused")) {
      console.log("  ✅ PASSED"); results.push({ name: "Deposit when paused", passed: true });
    } else {
      console.log("  ❌ FAILED: Wrong error"); results.push({ name: "Deposit when paused", passed: false });
    }
  }
  await program.methods.unpause().accountsStrict({ authority: payer.publicKey, vault }).rpc();

  // TEST 4: Redeem more shares than owned
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: Redeem more shares than owned");
  console.log("-".repeat(70));
  const userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  try {
    await program.methods.redeem(new BN(Number(userShares.amount) * 2), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
        assetVault, sharesMint, userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();
    console.log("  ❌ FAILED"); results.push({ name: "Excess redeem", passed: false });
  } catch {
    console.log("  ✅ PASSED"); results.push({ name: "Excess redeem", passed: true });
  }

  // TEST 5: Unauthorized sync
  console.log("\n" + "-".repeat(70));
  console.log("TEST 5: Unauthorized sync attempt (SVS-2 specific)");
  console.log("-".repeat(70));
  try {
    await program.methods.sync()
      .accountsStrict({ authority: unauthorized.publicKey, vault, assetVault })
      .signers([unauthorized])
      .rpc();
    console.log("  ❌ FAILED: Unauthorized sync succeeded"); results.push({ name: "Unauthorized sync", passed: false });
  } catch {
    console.log("  ✅ PASSED"); results.push({ name: "Unauthorized sync", passed: true });
  }

  // TEST 6: Authority transfer
  console.log("\n" + "-".repeat(70));
  console.log("TEST 6: Authority transfer");
  console.log("-".repeat(70));
  const newAuthority = Keypair.generate();
  await fundAccount(connection, payer, newAuthority.publicKey, 0.05);
  await program.methods.transferAuthority(newAuthority.publicKey)
    .accountsStrict({ authority: payer.publicKey, vault }).rpc();
  try {
    await program.methods.pause().accountsStrict({ authority: payer.publicKey, vault }).rpc();
    console.log("  ❌ FAILED"); results.push({ name: "Authority transfer", passed: false });
  } catch {
    console.log("  ✅ PASSED: Old authority blocked"); results.push({ name: "Authority transfer", passed: true });
  }

  // TEST 7: Multi-vault isolation
  console.log("\n" + "-".repeat(70));
  console.log("TEST 7: Multi-vault isolation");
  console.log("-".repeat(70));
  const vaultId2 = new BN(Date.now() + 1);
  const [vault2] = getVaultPDA(programId, assetMint, vaultId2);
  const [sharesMint2] = getSharesMintPDA(programId, vault2);
  const assetVault2 = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault2 });
  const userSharesAccount2 = getAssociatedTokenAddressSync(
    sharesMint2, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .initialize(vaultId2, "Second Vault", "VAULT2B", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault: vault2, assetMint, sharesMint: sharesMint2, assetVault: assetVault2,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

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
    console.log("  ❌ FAILED"); results.push({ name: "Vault isolation", passed: false });
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
