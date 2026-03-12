/**
 * SVS-2 Sync Timing Attack Test
 *
 * Migrated from SVS-1's sync.ts (tests 2-3).
 * Tests the attack vector where sync() is called between donation and victim deposit.
 *
 * Run: npx ts-node scripts/svs-2/sync-timing-attack.ts
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
  getMint,
} from "@solana/spl-token";
import { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { setupTest, getVaultPDA, getSharesMintPDA, syncVault, fundAccounts, ASSET_DECIMALS, SHARE_DECIMALS } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("Sync Timing Attack");

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const attacker = Keypair.generate();
  const victim = Keypair.generate();
  await fundAccounts(connection, payer, [attacker.publicKey, victim.publicKey], 0.05);

  const attackerAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, attacker.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  const victimAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, victim.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );

  const ATTACKER_DEPOSIT = 1;
  const ATTACKER_DONATION = 1_000_000;
  const VICTIM_DEPOSIT = 1_000;

  await mintTo(connection, payer, assetMint, attackerAta.address, payer,
    (ATTACKER_DEPOSIT + ATTACKER_DONATION) * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, victimAta.address, payer,
    VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });

  await program.methods
    .initialize(vaultId, "Timing Attack Test", "ATTACK2", "https://test.com")
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
  console.log("\n  Step 1: Attacker deposits 1 token");
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

  let attackerShares = await getAccount(connection, attackerSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`    Shares: ${Number(attackerShares.amount) / 10 ** SHARE_DECIMALS}`);

  // Step 2: Attacker donates 1M tokens
  console.log("\n  Step 2: Attacker donates 1M tokens directly to vault");
  await transfer(
    connection, attacker, attackerAta.address, assetVault, attacker,
    ATTACKER_DONATION * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
  );

  let vaultState = await program.account.vault.fetch(vault);
  let actualBalance = await getAccount(connection, assetVault);
  console.log(`    Stored total_assets: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`    Actual balance:      ${Number(actualBalance.amount) / 10 ** ASSET_DECIMALS}`);

  // Step 3: Authority calls sync (THIS IS THE ATTACK ENABLER)
  console.log("\n  Step 3: Authority calls sync() (THE ATTACK ENABLER)");
  await syncVault(program, payer, vault, assetVault);

  vaultState = await program.account.vault.fetch(vault);
  console.log(`    Stored total_assets AFTER sync: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  const sharesMintInfo = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
  const totalSharesBefore = Number(sharesMintInfo.supply);

  // Calculate expected victim shares
  const actualSharesCalc = (VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS) * totalSharesBefore / vaultState.totalAssets.toNumber();
  console.log(`\n    If victim deposits ${VICTIM_DEPOSIT} tokens now:`);
  console.log(`      Expected (fair):  ~${VICTIM_DEPOSIT} shares`);
  console.log(`      Actual calc:      ~${(actualSharesCalc / 10 ** SHARE_DECIMALS).toFixed(6)} shares`);

  // Step 4: Victim deposits
  console.log("\n  Step 4: Victim deposits 1000 tokens");

  try {
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
    const victimSharesNum = Number(victimShares.amount) / 10 ** SHARE_DECIMALS;

    console.log(`    Victim received: ${victimSharesNum} shares`);

    if (victimSharesNum < 1) {
      console.log("\n  ❌ EXPLOIT CONFIRMED: Victim received < 1 share!");
    } else if (victimSharesNum < VICTIM_DEPOSIT * 0.5) {
      console.log("\n  ⚠️  PARTIAL EXPLOIT: Victim got significantly fewer shares");
    } else {
      console.log("\n  ✅ Protected: Virtual offset mitigated the attack");
    }

    // Test victim redemption
    console.log("\n  Step 5: Victim redeems");
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
    console.log(`    Victim redeemed: ${victimRedeemed.toFixed(2)} tokens`);
    console.log(`    Loss: ${(VICTIM_DEPOSIT - victimRedeemed).toFixed(2)} tokens (${((1 - victimRedeemed/VICTIM_DEPOSIT) * 100).toFixed(2)}%)`);
  } catch (err: any) {
    console.log(`    Transaction failed: ${err.message}`);
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  SUMMARY: Sync Timing Attack Analysis");
  console.log("=".repeat(70));
  console.log(`
  Findings:

  1. sync() is admin-only: Prevents random attackers from syncing
  2. Donation without sync: ✅ Harmless (stored balance ignores it)
  3. Donation WITH sync: ⚠️  Potential exploit if authority is compromised
     - Virtual offset provides some protection
     - Authority should only sync for legitimate yield
  `);
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
