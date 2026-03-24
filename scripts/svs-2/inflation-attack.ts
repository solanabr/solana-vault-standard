/**
 * SVS-2 Inflation/Donation Attack Test
 *
 * Key difference from SVS-1: donations WITHOUT sync have NO effect
 * on share price because SVS-2 uses stored balance.
 *
 * Run: npx ts-node scripts/svs-2/inflation-attack.ts
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
  const { connection, payer, program, programId } = await setupTest("Inflation Attack (Stored Balance)");

  const attacker = Keypair.generate();
  const victim = Keypair.generate();

  await fundAccounts(connection, payer, [attacker.publicKey, victim.publicKey], 0.05);

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

  const ATTACKER_DEPOSIT = 1;
  const DONATION_AMOUNT = 1_000_000;
  const VICTIM_DEPOSIT = 1_000;

  await mintTo(connection, payer, assetMint, attackerAta.address, payer,
    (ATTACKER_DEPOSIT + DONATION_AMOUNT) * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, victimAta.address, payer,
    VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });

  await program.methods
    .initialize(vaultId, "Inflation Test SVS-2", "INFLAT2", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  const attackerSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, attacker.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const victimSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, victim.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Step 1: Attacker deposits 1 token
  console.log("\n--- Step 1: Attacker deposits 1 token ---");
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

  const attackerShares = await getAccount(connection, attackerSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Attacker shares: ${Number(attackerShares.amount) / 10 ** 9}`);

  // Step 2: Attacker donates 1M tokens directly (NO sync!)
  console.log("\n--- Step 2: Attacker donates 1M tokens directly (NO sync) ---");
  await transfer(
    connection, attacker, attackerAta.address, assetVault, attacker,
    DONATION_AMOUNT * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
  );

  const vaultState = await program.account.vault.fetch(vault);
  const actualBalance = await getAccount(connection, assetVault);

  console.log(`  Stored total_assets: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`  Actual balance:      ${Number(actualBalance.amount) / 10 ** ASSET_DECIMALS}`);
  console.log(`  Discrepancy:         ${(Number(actualBalance.amount) - vaultState.totalAssets.toNumber()) / 10 ** ASSET_DECIMALS}`);

  // Step 3: Victim deposits — should get FAIR shares (stored balance ignores donation)
  console.log("\n--- Step 3: Victim deposits 1000 tokens ---");
  console.log("  SVS-2: Stored balance means donation is invisible to share price");

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

  const victimShares = await getAccount(connection, victimSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const victimSharesNum = Number(victimShares.amount) / 10 ** 9;

  console.log(`  Victim received: ${victimSharesNum} shares`);

  // Analysis
  console.log("\n" + "=".repeat(70));
  console.log("  ANALYSIS");
  console.log("=".repeat(70));

  const attackerSharesNum = Number(attackerShares.amount) / 10 ** 9;
  const shareRatio = victimSharesNum / attackerSharesNum;
  const expectedRatio = VICTIM_DEPOSIT / ATTACKER_DEPOSIT;

  console.log(`\n  Victim/Attacker share ratio: ${shareRatio.toFixed(2)}x`);
  console.log(`  Expected fair ratio:         ${expectedRatio}x`);

  if (shareRatio >= expectedRatio * 0.9) {
    console.log("\n  ✅ PROTECTED: Donation without sync has NO effect on share price!");
    console.log("     SVS-2 stored balance model prevents this attack vector.");
  } else {
    console.log("\n  ❌ VULNERABLE: Donation affected share price without sync!");
  }

  // Verify victim can redeem fairly
  console.log("\n--- Testing victim redemption ---");
  const victimAssetsBefore = await getAccount(connection, victimAta.address);
  await program.methods
    .redeem(new BN(Number(victimShares.amount)), new BN(0))
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

  console.log(`  Victim redeemed: ${victimRedeemed.toFixed(2)} tokens (deposited: ${VICTIM_DEPOSIT})`);

  const loss = VICTIM_DEPOSIT - victimRedeemed;
  if (loss < 1) {
    console.log(`  ✅ Victim loss negligible: ${loss.toFixed(4)} tokens`);
  } else {
    console.log(`  ❌ Victim lost: ${loss.toFixed(2)} tokens`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("  TEST COMPLETE");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
