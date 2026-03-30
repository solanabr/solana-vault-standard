/**
 * SVS-9 Deallocate Script
 *
 * The curator withdraws principal (capital) from a child vault back to the idle vault.
 * Unlike harvest (which only takes profit), deallocate redeems shares proportionally
 * and reduces the cost basis accordingly.
 *
 * This script demonstrates the full flow:
 * 1. Initialize SVS-9 vault
 * 2. Add child vault
 * 3. Deposit into SVS-9
 * 4. Show deallocate call pattern with full account structure
 *
 * Run: npx ts-node scripts/svs-9/deallocate.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  setupTest,
  getAllocatorVaultPDA,
  getChildAllocationPDA,
  explorerUrl,
  ASSET_DECIMALS,
} from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("Deallocate");

  // ─── Note ───
  console.log("\n" + "-".repeat(70));
  console.log("  NOTE: Deallocate requires a live child SVS-1 vault with CPI.");
  console.log("  This script sets up the account structure and demonstrates");
  console.log("  the deallocate call pattern. For a full E2E test, use:");
  console.log("  `anchor test -- tests/svs-9.ts`");
  console.log("-".repeat(70));

  // ─── Step 1: Create Asset Mint ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Creating asset mint (Mock USDC)");
  console.log("-".repeat(70));

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );
  console.log(`  Asset Mint: ${assetMint.toBase58()}`);

  // ─── Step 2: Initialize SVS-9 Vault ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Initializing SVS-9 Allocator Vault");
  console.log("-".repeat(70));

  const vaultId = new BN(Date.now());
  const sharesMintKeypair = Keypair.generate();
  const [allocatorVault] = getAllocatorVaultPDA(programId, assetMint, vaultId);
  const idleVault = anchor.utils.token.associatedAddress({
    mint: assetMint,
    owner: allocatorVault,
  });

  const initTx = await program.methods
    .initialize(vaultId, 1000, 0) // 10% idle buffer, decimals_offset=0
    .accountsPartial({
      authority: payer.publicKey,
      curator: payer.publicKey,
      allocatorVault,
      assetMint,
      sharesMint: sharesMintKeypair.publicKey,
      idleVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer, sharesMintKeypair])
    .rpc();

  console.log(`  Vault PDA: ${allocatorVault.toBase58()}`);
  console.log(`  Tx: ${explorerUrl(initTx)}`);

  // ─── Step 3: Add Child Vault ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Adding child vault (mock)");
  console.log("-".repeat(70));

  const childVault = Keypair.generate().publicKey;
  const [childAllocation] = getChildAllocationPDA(programId, allocatorVault, childVault);

  const addChildTx = await program.methods
    .addChild(5000) // 50% max weight
    .accountsPartial({
      authority: payer.publicKey,
      allocatorVault,
      childAllocation,
      childVault,
      childProgram: programId,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer])
    .rpc();

  console.log(`  Child Vault: ${childVault.toBase58()}`);
  console.log(`  Child Allocation PDA: ${childAllocation.toBase58()}`);
  console.log(`  Tx: ${explorerUrl(addChildTx)}`);

  // ─── Step 4: Deposit into SVS-9 ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Depositing assets into SVS-9");
  console.log("-".repeat(70));

  const userAssetAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  await mintTo(
    connection, payer, assetMint, userAssetAta.address, payer.publicKey,
    1_000_000 * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
  );

  const userSharesAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, sharesMintKeypair.publicKey, payer.publicKey,
    false, undefined, undefined, TOKEN_2022_PROGRAM_ID
  );

  await program.methods
    .deposit(new BN(500_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsPartial({
      caller: payer.publicKey,
      owner: payer.publicKey,
      allocatorVault,
      idleVault,
      sharesMint: sharesMintKeypair.publicKey,
      callerAssetAccount: userAssetAta.address,
      ownerSharesAccount: userSharesAta.address,
      assetMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer])
    .rpc();

  console.log(`  Deposited 500,000 tokens`);

  // ─── Step 5: Show Deallocate call pattern ───
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Deallocate call pattern");
  console.log("-".repeat(70));

  console.log(`
  The deallocate instruction requires the following accounts:
  
    curator:                      Signer (must match vault curator)
    allocator_vault:              ${allocatorVault.toBase58()}
    child_allocation:             ${childAllocation.toBase58()}
    idle_vault:                   ${idleVault.toBase58()}
    child_vault:                  <child SVS-1 vault PDA>
    child_program:                <SVS-1 program ID>
    allocator_child_shares_acct:  <ATA of allocator for child shares>
    child_asset_mint:             <child vault's asset mint>
    child_asset_vault:            <child vault's asset ATA>
    child_shares_mint:            <child vault's shares mint>
    token_program:                TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
    token_2022_program:           TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
    associated_token_program:     ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
    system_program:               11111111111111111111111111111111

  Usage via CLI:
    program.methods
      .deallocate(new BN(shares_to_withdraw))
      .accountsPartial({ ... })
      .signers([curator])
      .rpc();

  Key differences from harvest:
    - Harvest only takes yield (profit above cost basis)
    - Deallocate withdraws principal proportionally
    - Deallocate reduces deposited_assets (cost basis) proportionally
    - Both use CPI to child_vault::redeem() under the hood
  `);

  // ─── Summary ───
  console.log("=".repeat(70));
  console.log("  ✅ SVS-9 Deallocate demonstration completed!");
  console.log("  For a full CPI deallocate test, run: anchor test -- tests/svs-9.ts");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
