/**
 * SVS-1 Inflation/Donation Attack Test
 *
 * Tests protection against the classic ERC-4626 inflation attack:
 * 1. Attacker deposits minimal amount (1 token)
 * 2. Attacker donates large amount directly to vault (bypassing deposit)
 * 3. Victim deposits - should NOT get unfairly few shares
 *
 * Run: npx ts-node scripts/svs-1/inflation-attack.ts
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
import { setupTest, getVaultPDA, getSharesMintPDA, fundAccounts, ASSET_DECIMALS } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("Inflation/Donation Attack");

  // Create attacker and victim
  const attacker = Keypair.generate();
  const victim = Keypair.generate();

  console.log(`Attacker: ${attacker.publicKey.toBase58()}`);
  console.log(`Victim: ${victim.publicKey.toBase58()}`);

  // Fund with SOL (transfer, not airdrop)
  console.log("\n--- Funding test accounts ---");
  await fundAccounts(connection, payer, [attacker.publicKey, victim.publicKey], 0.05);
  console.log("  Funded attacker and victim with 0.05 SOL each");

  // Create asset mint
  console.log("\n--- Creating test token ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  // Create token accounts
  const attackerAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, attacker.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  const victimAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, victim.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );

  const ATTACKER_DEPOSIT = 1; // 1 token (minimal)
  const DONATION_AMOUNT = 1_000_000; // 1M tokens (large donation)
  const VICTIM_DEPOSIT = 1_000; // 1000 tokens (normal deposit)

  await mintTo(connection, payer, assetMint, attackerAta.address, payer,
    (ATTACKER_DEPOSIT + DONATION_AMOUNT) * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, victimAta.address, payer,
    VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS);

  console.log(`  Attacker tokens: ${(ATTACKER_DEPOSIT + DONATION_AMOUNT).toLocaleString()}`);
  console.log(`  Victim tokens: ${VICTIM_DEPOSIT.toLocaleString()}`);

  // Initialize vault
  console.log("\n--- Initializing vault ---");
  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });

  await program.methods
    .initialize(vaultId, "Inflation Test Vault", "INFLAT", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // ATTACK SCENARIO
  console.log("\n" + "=".repeat(70));
  console.log("  ATTACK SCENARIO");
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
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([attacker])
    .rpc();

  const attackerSharesAfterDeposit = await getAccount(connection, attackerSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Attacker shares: ${Number(attackerSharesAfterDeposit.amount) / 10 ** 9}`);

  // Step 2: Attacker donates directly to vault
  console.log("\n--- Step 2: Attacker donates 1M tokens directly to vault ---");
  console.log("  (This bypasses deposit - direct transfer to asset vault)");

  await transfer(
    connection, attacker, attackerAta.address, assetVault, attacker,
    DONATION_AMOUNT * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
  );

  const vaultBalanceAfterDonation = await getAccount(connection, assetVault);
  const vaultState = await program.account.vault.fetch(vault);
  console.log(`  Asset vault balance: ${Number(vaultBalanceAfterDonation.amount) / 10 ** ASSET_DECIMALS}`);
  console.log(`  Vault total_assets: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`  ⚠️  Mismatch! This is the attack vector.`);

  // Step 3: Victim deposits
  console.log("\n--- Step 3: Victim deposits 1000 tokens ---");
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
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([victim])
    .rpc();

  const victimSharesAfter = await getAccount(connection, victimSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const victimSharesReceived = Number(victimSharesAfter.amount) / 10 ** 9;

  console.log(`  Victim deposited: ${VICTIM_DEPOSIT} tokens`);
  console.log(`  Victim received: ${victimSharesReceived} shares`);

  // ANALYSIS
  console.log("\n" + "=".repeat(70));
  console.log("  ANALYSIS");
  console.log("=".repeat(70));

  const attackerShares = Number(attackerSharesAfterDeposit.amount) / 10 ** 9;
  const shareRatio = victimSharesReceived / attackerShares;
  const expectedRatio = VICTIM_DEPOSIT / ATTACKER_DEPOSIT;

  console.log(`
  Attacker deposited: ${ATTACKER_DEPOSIT} token
  Attacker shares:    ${attackerShares}

  Attacker donated:   ${DONATION_AMOUNT.toLocaleString()} tokens (directly)

  Victim deposited:   ${VICTIM_DEPOSIT} tokens
  Victim shares:      ${victimSharesReceived}

  Share ratio (victim/attacker): ${shareRatio.toFixed(2)}x
  Expected fair ratio:           ${expectedRatio}x
  `);

  if (shareRatio < expectedRatio * 0.5) {
    console.log("  ❌ VULNERABLE: Victim got significantly fewer shares!");
    console.log("     Donation attack was successful.");
  } else if (shareRatio >= expectedRatio * 0.9) {
    console.log("  ✅ PROTECTED: Victim received fair shares!");
    console.log("     Virtual offset protection is working.");
  } else {
    console.log("  ⚠️  PARTIAL: Some impact, but not catastrophic.");
  }

  // Victim redemption test
  console.log("\n--- Testing victim redemption ---");

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

  console.log("\n" + "=".repeat(70));
  console.log("  TEST COMPLETE");
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
