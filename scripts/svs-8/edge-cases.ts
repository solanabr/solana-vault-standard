/**
 * SVS-8 Edge Cases Script
 *
 * Tests security and error conditions on devnet:
 * - Deposit below minimum
 * - Deposit on paused vault
 * - Slippage protection
 *
 * Run: npx ts-node scripts/svs-8/edge-cases.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  setupScript, getVaultPDA, getSharesMintPDA, getAssetEntryPDA,
  getOraclePricePDA, PRICE_SCALE,
} from "./helpers";

async function expectError(fn: () => Promise<any>, label: string) {
  try {
    await fn();
    console.log(`  ❌ FAIL: ${label} should have thrown`);
  } catch (_e) {
    console.log(`  ✅ PASS: ${label} correctly rejected`);
  }
}

async function main() {
  const { connection, payer, program, programId } = await setupScript("Edge Cases");

  // Setup
  const mintA = await createMint(connection, payer, payer.publicKey, null, 6, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
  const userAtaA = await getOrCreateAssociatedTokenAccount(connection, payer, mintA, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID);
  await mintTo(connection, payer, mintA, userAtaA.address, payer.publicKey, 10_000_000, [], undefined, TOKEN_PROGRAM_ID);

  const vaultId = new BN(Date.now());
  const [vaultPda] = getVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vaultPda);
  const [assetEntryA] = getAssetEntryPDA(programId, vaultPda, mintA);
  const [oraclePriceA] = getOraclePricePDA(programId, vaultPda, mintA);
  const assetVaultAKeypair = Keypair.generate();

  await program.methods.initialize(vaultId, 6)
    .accountsPartial({ authority: payer.publicKey, sharesMint, tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .rpc();
  console.log("  Vault initialized");

  await program.methods.addAsset(10_000)
    .accountsPartial({ vault: vaultPda, authority: payer.publicKey, assetMint: mintA, oracle: Keypair.generate().publicKey, assetEntry: assetEntryA, assetVault: assetVaultAKeypair.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .signers([assetVaultAKeypair]).rpc();
  console.log("  Asset A added");

  await program.methods.updateOracle(new BN(PRICE_SCALE))
    .accountsPartial({ vault: vaultPda, assetMint: mintA, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("  Oracle set");

  const userSharesAta = await getOrCreateAssociatedTokenAccount(connection, payer, sharesMint, payer.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID);

  const depositAccounts = {
    user: payer.publicKey, vault: vaultPda, assetEntry: assetEntryA,
    assetMint: mintA, oraclePrice: oraclePriceA,
    assetVaultAccount: assetVaultAKeypair.publicKey,
    sharesMint, userAssetAccount: userAtaA.address,
    userSharesAccount: userSharesAta.address,
    tokenProgram: TOKEN_PROGRAM_ID, sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };

  console.log("\n--- Edge Case Tests ---\n");

  await expectError(
    () => program.methods.depositSingle(new BN(10), new BN(0)).accountsPartial(depositAccounts).rpc(),
    "Deposit below minimum (10 < 1000)"
  );

  await expectError(
    () => program.methods.depositSingle(new BN(1_000_000), new BN(999_999_999_999)).accountsPartial(depositAccounts).rpc(),
    "Slippage protection (min_shares_out too high)"
  );

  await program.methods.pause().accounts({ vault: vaultPda }).rpc();
  console.log("  Vault paused");

  await expectError(
    () => program.methods.depositSingle(new BN(1_000_000), new BN(0)).accountsPartial(depositAccounts).rpc(),
    "Deposit on paused vault"
  );

  await program.methods.unpause().accounts({ vault: vaultPda }).rpc();
  console.log("  Vault unpaused");

  // Valid deposit to test redeem edge case
  await program.methods.depositSingle(new BN(1_000_000), new BN(0)).accountsPartial(depositAccounts).rpc();
  console.log("  Valid deposit done");

  const { getMint } = await import("@solana/spl-token");
  const mintInfo = await getMint(connection, sharesMintPda, undefined, TOKEN_2022_PROGRAM_ID);
  await expectError(
    () => program.methods.redeemProportional(new BN(Number(mintInfo.supply) * 2), new BN(0))
      .accountsPartial({ user: payer.publicKey, vault: vaultPda, sharesMint, userSharesAccount: userSharesAta.address, tokenProgram: TOKEN_PROGRAM_ID, sharesTokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .remainingAccounts([
        { pubkey: assetEntryA, isWritable: false, isSigner: false },
        { pubkey: oraclePriceA, isWritable: false, isSigner: false },
        { pubkey: assetVaultAKeypair.publicKey, isWritable: true, isSigner: false },
        { pubkey: userAtaA.address, isWritable: true, isSigner: false },
        { pubkey: mintA, isWritable: false, isSigner: false },
      ])
      .rpc(),
    "Redeem more shares than balance"
  );

  console.log("\n" + "=".repeat(70));
  console.log("  ✅ All edge case tests completed!");
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
