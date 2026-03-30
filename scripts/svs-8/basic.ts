/**
 * SVS-8 Basic Script
 *
 * Demonstrates core basket vault functionality on devnet:
 * - Initialize vault
 * - Add two assets (50/50 split)
 * - Set oracle prices
 * - Deposit single asset
 * - Redeem proportional
 *
 * Run: npx ts-node scripts/svs-8/basic.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  setupScript, getVaultPDA, getSharesMintPDA, getAssetEntryPDA, getOraclePricePDA,
  explorerUrl, accountUrl, ASSET_DECIMALS, PRICE_SCALE,
} from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupScript("Basic Functionality");

  // Step 1: Create test tokens
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Creating test tokens (Mock USDC + Mock USDT)");
  console.log("-".repeat(70));

  const mintA = await createMint(connection, payer, payer.publicKey, null, ASSET_DECIMALS, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
  const mintB = await createMint(connection, payer, payer.publicKey, null, ASSET_DECIMALS, Keypair.generate(), undefined, TOKEN_PROGRAM_ID);
  console.log(`  Mint A (Mock USDC): ${mintA.toBase58()}`);
  console.log(`  Mint B (Mock USDT): ${mintB.toBase58()}`);

  // Step 2: Mint tokens to user
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Minting tokens to user");
  console.log("-".repeat(70));

  const userAtaA = await getOrCreateAssociatedTokenAccount(connection, payer, mintA, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID);
  const userAtaB = await getOrCreateAssociatedTokenAccount(connection, payer, mintB, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID);

  await mintTo(connection, payer, mintA, userAtaA.address, payer.publicKey, 10_000_000, [], undefined, TOKEN_PROGRAM_ID);
  await mintTo(connection, payer, mintB, userAtaB.address, payer.publicKey, 10_000_000, [], undefined, TOKEN_PROGRAM_ID);
  console.log(`  Minted 10 tokens of each to ${payer.publicKey.toBase58()}`);

  // Step 3: Derive PDAs
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Deriving PDAs");
  console.log("-".repeat(70));

  const vaultId = new BN(Date.now());
  const [vaultPda] = getVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vaultPda);
  const [assetEntryA] = getAssetEntryPDA(programId, vaultPda, mintA);
  const [assetEntryB] = getAssetEntryPDA(programId, vaultPda, mintB);
  const [oraclePriceA] = getOraclePricePDA(programId, vaultPda, mintA);
  const [oraclePriceB] = getOraclePricePDA(programId, vaultPda, mintB);

  console.log(`  Vault PDA: ${accountUrl(vaultPda.toBase58())}`);
  console.log(`  Shares Mint: ${accountUrl(sharesMint.toBase58())}`);

  // Step 4: Initialize vault
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Initializing vault");
  console.log("-".repeat(70));

  const initTx = await program.methods
    .initialize(vaultId, 6)
    .accountsPartial({
      authority: payer.publicKey,
      sharesMint,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(`  ✅ Vault initialized: ${explorerUrl(initTx)}`);

  // Step 5: Add assets
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Adding assets (50/50 split)");
  console.log("-".repeat(70));

  const assetVaultAKeypair = Keypair.generate();
  const assetVaultBKeypair = Keypair.generate();

  const addATx = await program.methods
    .addAsset(5_000)
    .accountsPartial({
      vault: vaultPda, authority: payer.publicKey, assetMint: mintA,
      oracle: Keypair.generate().publicKey,
      assetEntry: assetEntryA, assetVault: assetVaultAKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([assetVaultAKeypair])
    .rpc();
  console.log(`  ✅ Asset A added: ${explorerUrl(addATx)}`);

  const addBTx = await program.methods
    .addAsset(5_000)
    .accountsPartial({
      vault: vaultPda, authority: payer.publicKey, assetMint: mintB,
      oracle: Keypair.generate().publicKey,
      assetEntry: assetEntryB, assetVault: assetVaultBKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([assetVaultBKeypair])
    .rpc();
  console.log(`  ✅ Asset B added: ${explorerUrl(addBTx)}`);

  // Step 6: Set oracle prices
  console.log("\n" + "-".repeat(70));
  console.log("Step 6: Setting oracle prices (1.0 USDC each)");
  console.log("-".repeat(70));

  const oracleATx = await program.methods
    .updateOracle(new BN(PRICE_SCALE))
    .accountsPartial({
      vault: vaultPda, assetMint: mintA,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  ✅ Oracle A set: ${explorerUrl(oracleATx)}`);

  const oracleBTx = await program.methods
    .updateOracle(new BN(PRICE_SCALE))
    .accountsPartial({
      vault: vaultPda, assetMint: mintB,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  ✅ Oracle B set: ${explorerUrl(oracleBTx)}`);

  // Step 7: Deposit
  console.log("\n" + "-".repeat(70));
  console.log("Step 7: Depositing 1 token of Asset A");
  console.log("-".repeat(70));

  const userSharesAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, sharesMint, payer.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID
  );

  const depositTx = await program.methods
    .depositSingle(new BN(1_000_000), new BN(0))
    .accountsPartial({
      user: payer.publicKey, vault: vaultPda, assetEntry: assetEntryA,
      assetMint: mintA, oraclePrice: oraclePriceA,
      assetVaultAccount: assetVaultAKeypair.publicKey,
      sharesMint, userAssetAccount: userAtaA.address,
      userSharesAccount: userSharesAta.address,
      tokenProgram: TOKEN_PROGRAM_ID, sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: assetEntryB, isWritable: false, isSigner: false },
      { pubkey: oraclePriceB, isWritable: false, isSigner: false },
      { pubkey: assetVaultBKeypair.publicKey, isWritable: true, isSigner: false },
    ])
    .rpc();
  console.log(`  ✅ Deposit: ${explorerUrl(depositTx)}`);

  const vault = await program.account.multiAssetVault.fetch(vaultPda);
  console.log(`  Vault initialized successfully`);

  // Step 8: Redeem proportional
  console.log("\n" + "-".repeat(70));
  console.log("Step 8: Redeeming 50% of shares");
  console.log("-".repeat(70));

  const { getMint } = await import("@solana/spl-token");
  const mintInfo = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
  const sharesToRedeem = new BN(Number(mintInfo.supply) / 2);

  const redeemTx = await program.methods
    .redeemProportional(sharesToRedeem, new BN(0))
    .accountsPartial({
      user: payer.publicKey, vault: vaultPda, sharesMint,
      userSharesAccount: userSharesAta.address,
      tokenProgram: TOKEN_PROGRAM_ID, sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      // Asset A: [AssetEntry, OraclePrice, vault_ata, user_ata, mint]
      { pubkey: assetEntryA, isWritable: false, isSigner: false },
      { pubkey: oraclePriceA, isWritable: false, isSigner: false },
      { pubkey: assetVaultAKeypair.publicKey, isWritable: true, isSigner: false },
      { pubkey: userAtaA.address, isWritable: true, isSigner: false },
      { pubkey: mintA, isWritable: false, isSigner: false },
      // Asset B: [AssetEntry, OraclePrice, vault_ata, user_ata, mint]
      { pubkey: assetEntryB, isWritable: false, isSigner: false },
      { pubkey: oraclePriceB, isWritable: false, isSigner: false },
      { pubkey: assetVaultBKeypair.publicKey, isWritable: true, isSigner: false },
      { pubkey: userAtaB.address, isWritable: true, isSigner: false },
      { pubkey: mintB, isWritable: false, isSigner: false },
    ])
    .rpc();
  console.log(`  ✅ Redeem: ${explorerUrl(redeemTx)}`);

  const vaultAfter = await program.account.multiAssetVault.fetch(vaultPda);
  const mintAfter = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Shares after redeem: ${mintAfter.supply.toString()}`);

  console.log("\n" + "=".repeat(70));
  console.log("  ✅ All steps completed successfully!");
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
