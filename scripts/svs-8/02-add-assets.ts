/**
 * SVS-8 Add Assets Script
 *
 * Adds 3 test assets to an existing vault: USDC (50%), SOL-like (30%), BONK-like (20%).
 * Requires vault_id as CLI arg or uses Date.now().
 *
 * Run: npx ts-node scripts/svs-8/02-add-assets.ts
 */

import { BN } from "@coral-xyz/anchor";
import {
  createMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  setupTest,
  getVaultPDA,
  getAssetEntryPDA,
  getAssetVaultATA,
  explorerUrl,
  accountUrl,
} from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("SVS-8 Add Assets");

  // Use vault_id from CLI or find existing vault
  const vaultIdArg = process.argv[2];
  if (!vaultIdArg) {
    console.error("Usage: npx ts-node scripts/svs-8/02-add-assets.ts <vault_id>");
    console.error("  Get vault_id from 01-initialize.ts output");
    process.exit(1);
  }
  const vaultId = new BN(vaultIdArg);
  const [vault] = getVaultPDA(programId, vaultId);

  console.log(`\nVault: ${vault.toBase58()}`);

  // Create 3 mock mints
  const assets = [
    { name: "USDC", decimals: 6, weight: 5000 },
    { name: "SOL", decimals: 9, weight: 3000 },
    { name: "BONK", decimals: 5, weight: 2000 },
  ];

  const existingEntries: { pubkey: any; isSigner: boolean; isWritable: boolean }[] = [];

  for (const asset of assets) {
    console.log(`\n${"-".repeat(70)}`);
    console.log(`Adding ${asset.name} (${asset.weight / 100}% weight, ${asset.decimals} decimals)`);
    console.log("-".repeat(70));

    const mint = await createMint(
      connection, payer, payer.publicKey, null, asset.decimals,
      Keypair.generate(), undefined, TOKEN_PROGRAM_ID
    );

    // Create mock oracle account (16 bytes, program-owned)
    const oracle = Keypair.generate();
    const space = 16;
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    const oracleTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: oracle.publicKey,
        lamports,
        space,
        programId: program.programId,
      })
    );
    await sendAndConfirmTransaction(connection, oracleTx, [payer, oracle]);

    const [entry] = getAssetEntryPDA(programId, vault, mint);
    const assetVault = getAssetVaultATA(mint, vault);

    const tx = await program.methods
      .addAsset(asset.weight, 2)
      .accountsStrict({
        authority: payer.publicKey,
        vault,
        assetMint: mint,
        oracle: oracle.publicKey,
        assetEntry: entry,
        assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(existingEntries)
      .rpc();

    console.log(`  Mint: ${mint.toBase58()}`);
    console.log(`  Oracle: ${oracle.publicKey.toBase58()}`);
    console.log(`  Entry PDA: ${entry.toBase58()}`);
    console.log(`  Asset Vault: ${assetVault.toBase58()}`);
    console.log(`  TX: ${explorerUrl(tx)}`);

    existingEntries.push({ pubkey: entry, isSigner: false, isWritable: false });
  }

  const vaultAccount = await program.account.multiAssetVault.fetch(vault);
  console.log(`\nVault now has ${vaultAccount.numAssets} assets`);
}

main().catch(console.error);
