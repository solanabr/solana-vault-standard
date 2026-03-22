/**
 * SVS-5 Inflation/Donation Attack Test
 *
 * Tests protection against the classic ERC-4626 inflation attack
 * during an active yield stream:
 * 1. Attacker deposits minimal amount (1 token)
 * 2. Yield stream starts
 * 3. Attacker donates large amount directly to vault
 * 4. Victim deposits - should NOT get unfairly few shares
 *
 * Run: npx ts-node scripts/svs-5/inflation-attack.ts
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
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { setupTest, getVaultPDA, getSharesMintPDA, fundAccounts, createSharesAtaIx, ASSET_DECIMALS } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("Inflation/Donation Attack (Streaming)");

  const attacker = Keypair.generate();
  const victim = Keypair.generate();

  console.log(`Attacker: ${attacker.publicKey.toBase58()}`);
  console.log(`Victim: ${victim.publicKey.toBase58()}`);

  console.log("\n--- Funding test accounts ---");
  await fundAccounts(connection, payer, [attacker.publicKey, victim.publicKey], 0.05);
  console.log("  Funded attacker and victim with 0.05 SOL each");

  console.log("\n--- Creating test token ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const attackerAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, attacker.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  const victimAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, victim.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  const authorityAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );

  const ATTACKER_DEPOSIT = 1;
  const DONATION_AMOUNT = 1_000_000;
  const VICTIM_DEPOSIT = 1_000;
  const YIELD_AMOUNT = 5_000;

  await mintTo(connection, payer, assetMint, attackerAta.address, payer,
    (ATTACKER_DEPOSIT + DONATION_AMOUNT) * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, victimAta.address, payer,
    VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, authorityAta.address, payer,
    YIELD_AMOUNT * 10 ** ASSET_DECIMALS);

  console.log(`  Attacker tokens: ${(ATTACKER_DEPOSIT + DONATION_AMOUNT).toLocaleString()}`);
  console.log(`  Victim tokens: ${VICTIM_DEPOSIT.toLocaleString()}`);

  // Initialize vault
  console.log("\n--- Initializing streaming vault ---");
  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });

  await program.methods
    .initialize(vaultId)
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // ATTACK SCENARIO
  console.log("\n" + "=".repeat(70));
  console.log("  ATTACK SCENARIO (during active stream)");
  console.log("=".repeat(70));

  // Step 1: Attacker deposits 1 token
  console.log("\n--- Step 1: Attacker deposits 1 token ---");
  const attackerSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, attacker.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .deposit(new BN(ATTACKER_DEPOSIT * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: attacker.publicKey, vault, assetMint,
      userAssetAccount: attackerAta.address, assetVault, sharesMint,
      userSharesAccount: attackerSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(attacker.publicKey, attacker.publicKey, sharesMint)])
    .signers([attacker])
    .rpc();

  const attackerSharesAfterDeposit = await getAccount(connection, attackerSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Attacker shares: ${Number(attackerSharesAfterDeposit.amount) / 10 ** 9}`);

  // Step 2: Start yield stream
  console.log("\n--- Step 2: Authority starts yield stream ---");
  await program.methods
    .distributeYield(new BN(YIELD_AMOUNT * 10 ** ASSET_DECIMALS), new BN(120))
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint,
      authorityAssetAccount: authorityAta.address, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`  Stream: ${YIELD_AMOUNT.toLocaleString()} tokens over 120s`);

  // Step 3: Attacker donates directly to vault
  console.log("\n--- Step 3: Attacker donates 1M tokens directly to vault ---");
  console.log("  (This bypasses deposit - direct transfer to asset vault)");

  await transfer(
    connection, attacker, attackerAta.address, assetVault, attacker,
    DONATION_AMOUNT * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
  );

  const vaultBalanceAfterDonation = await getAccount(connection, assetVault);
  console.log(`  Asset vault balance: ${Number(vaultBalanceAfterDonation.amount) / 10 ** ASSET_DECIMALS}`);

  // Step 4: Victim deposits
  console.log("\n--- Step 4: Victim deposits 1000 tokens ---");
  console.log("  If vulnerable, victim would get almost 0 shares");

  const victimSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, victim.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .deposit(new BN(VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: victim.publicKey, vault, assetMint,
      userAssetAccount: victimAta.address, assetVault, sharesMint,
      userSharesAccount: victimSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(victim.publicKey, victim.publicKey, sharesMint)])
    .signers([victim])
    .rpc();

  const victimSharesAfter = await getAccount(connection, victimSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const victimSharesReceived = Number(victimSharesAfter.amount) / 10 ** 9;

  console.log(`  Victim deposited: ${VICTIM_DEPOSIT} tokens`);
  console.log(`  Victim received: ${victimSharesReceived} shares`);

  // Victim redemption test
  console.log("\n--- Testing victim redemption ---");

  // Checkpoint to materialize yield first
  await program.methods.checkpoint().accountsStrict({ vault }).rpc();

  const victimAssetsBefore = await getAccount(connection, victimAta.address);

  await program.methods
    .redeem(new BN(Number(victimSharesAfter.amount)), new BN(0))
    .accountsStrict({
      user: victim.publicKey, vault, assetMint,
      userAssetAccount: victimAta.address, assetVault, sharesMint,
      userSharesAccount: victimSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers([victim])
    .rpc();

  const victimAssetsAfter = await getAccount(connection, victimAta.address);
  const victimRedeemed = (Number(victimAssetsAfter.amount) - Number(victimAssetsBefore.amount)) / 10 ** ASSET_DECIMALS;

  console.log(`  Victim redeemed: ${victimRedeemed.toFixed(2)} tokens`);
  console.log(`  Original deposit: ${VICTIM_DEPOSIT} tokens`);

  const profitLoss = victimRedeemed - VICTIM_DEPOSIT;
  console.log(`  Result: ${profitLoss >= 0 ? '+' : ''}${profitLoss.toFixed(2)} ${profitLoss >= 0 ? 'profit' : 'loss'}`);

  const lossPercent = -profitLoss / VICTIM_DEPOSIT * 100; // positive = loss
  console.log("\n" + "=".repeat(70));
  if (profitLoss >= 0) {
    console.log("  ✅ PROTECTED: Victim did not lose tokens despite donation attack");
    console.log(`     Result: +${(profitLoss / VICTIM_DEPOSIT * 100).toFixed(4)}% (virtual offset protection working)`);
  } else if (lossPercent < 1) {
    console.log("  ✅ PROTECTED: Victim redeemed ~full deposit despite donation attack");
    console.log(`     Loss: ${lossPercent.toFixed(4)}% (virtual offset protection working)`);
  } else {
    console.log("  ❌ VULNERABLE: Victim lost significant tokens on redemption");
    console.log(`     Loss: ${lossPercent.toFixed(2)}%`);
  }
  console.log("=".repeat(70) + "\n");

  if (lossPercent >= 1) process.exit(1);
}

main().catch(console.error);
