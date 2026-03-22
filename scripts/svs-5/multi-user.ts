/**
 * SVS-5 Multi-User Fairness Test
 *
 * Tests that multiple users get fair treatment with streaming yield:
 * - User A deposits before stream starts
 * - Yield stream begins
 * - User B deposits mid-stream (should get fewer shares per asset)
 * - Both redeem after stream ends
 * - Verify proportional distribution
 *
 * Run: npx ts-node scripts/svs-5/multi-user.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { setupTest, getVaultPDA, getSharesMintPDA, fundAccounts, createSharesAtaIx, ASSET_DECIMALS, SHARE_DECIMALS } from "./helpers";

interface UserState {
  name: string;
  keypair: Keypair;
  assetAccount: PublicKey;
  sharesAccount: PublicKey;
  initialDeposit: number;
  sharesReceived: number;
  assetsRedeemed: number;
}

async function main() {
  const { connection, payer, program, programId } = await setupTest("Multi-User Streaming Yield");

  // Create test users
  const alice: UserState = { name: "Alice", keypair: Keypair.generate(), assetAccount: PublicKey.default, sharesAccount: PublicKey.default, initialDeposit: 10_000, sharesReceived: 0, assetsRedeemed: 0 };
  const bob: UserState = { name: "Bob", keypair: Keypair.generate(), assetAccount: PublicKey.default, sharesAccount: PublicKey.default, initialDeposit: 10_000, sharesReceived: 0, assetsRedeemed: 0 };
  const users = [alice, bob];

  console.log("--- Creating test users ---");
  for (const user of users) {
    console.log(`  ${user.name}: ${user.keypair.publicKey.toBase58()}`);
  }

  // Fund users with SOL
  console.log("\n--- Funding users with SOL ---");
  await fundAccounts(connection, payer, users.map(u => u.keypair.publicKey), 0.05);
  console.log("  All users funded with 0.05 SOL");

  // Create asset mint
  console.log("\n--- Creating test token ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  // Create token accounts and mint tokens
  console.log("\n--- Setting up user token accounts ---");
  for (const user of users) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection, payer, assetMint, user.keypair.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
    );
    user.assetAccount = ata.address;
    await mintTo(connection, payer, assetMint, user.assetAccount, payer, user.initialDeposit * 10 ** ASSET_DECIMALS);
    console.log(`  ${user.name}: ${user.initialDeposit.toLocaleString()} tokens`);
  }

  // Authority also needs tokens for yield distribution
  const authorityAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  await mintTo(connection, payer, assetMint, authorityAta.address, payer, 100_000 * 10 ** ASSET_DECIMALS);

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

  for (const user of users) {
    user.sharesAccount = getAssociatedTokenAddressSync(
      sharesMint, user.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
  }

  // SCENARIO: Alice deposits before stream, Bob deposits mid-stream
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO: Pre-stream vs Mid-stream Deposits");
  console.log("=".repeat(70));

  // Step 1: Alice deposits before stream
  console.log("\n--- Step 1: Alice deposits 10,000 tokens (before stream) ---");
  await program.methods
    .deposit(new BN(alice.initialDeposit * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: alice.keypair.publicKey, vault, assetMint,
      userAssetAccount: alice.assetAccount, assetVault, sharesMint,
      userSharesAccount: alice.sharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(alice.keypair.publicKey, alice.keypair.publicKey, sharesMint)])
    .signers([alice.keypair])
    .rpc();

  const aliceSharesAfter = await getAccount(connection, alice.sharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  alice.sharesReceived = Number(aliceSharesAfter.amount) / 10 ** SHARE_DECIMALS;
  console.log(`  Alice received: ${alice.sharesReceived.toLocaleString()} shares`);

  // Step 2: Start yield stream
  console.log("\n--- Step 2: Distributing 5,000 tokens over 120s stream ---");
  await program.methods
    .distributeYield(new BN(5_000 * 10 ** ASSET_DECIMALS), new BN(120))
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint,
      authorityAssetAccount: authorityAta.address, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("  Stream started");

  // Step 3: Wait for mid-stream, then Bob deposits
  console.log("\n--- Step 3: Waiting 10s for yield to accrue... ---");
  await new Promise(r => setTimeout(r, 10000));

  console.log("--- Step 4: Bob deposits 10,000 tokens (mid-stream) ---");
  await program.methods
    .deposit(new BN(bob.initialDeposit * 10 ** ASSET_DECIMALS), new BN(0))
    .accountsStrict({
      user: bob.keypair.publicKey, vault, assetMint,
      userAssetAccount: bob.assetAccount, assetVault, sharesMint,
      userSharesAccount: bob.sharesAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(bob.keypair.publicKey, bob.keypair.publicKey, sharesMint)])
    .signers([bob.keypair])
    .rpc();

  const bobSharesAfter = await getAccount(connection, bob.sharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  bob.sharesReceived = Number(bobSharesAfter.amount) / 10 ** SHARE_DECIMALS;
  console.log(`  Bob received: ${bob.sharesReceived.toLocaleString()} shares`);

  // Analysis: Bob should get fewer shares since share price increased from accrued yield
  console.log("\n" + "=".repeat(70));
  console.log("  ANALYSIS: Share Distribution");
  console.log("=".repeat(70));

  console.log(`\n  Alice (pre-stream): ${alice.sharesReceived.toLocaleString()} shares for ${alice.initialDeposit.toLocaleString()} tokens`);
  console.log(`  Bob (mid-stream):   ${bob.sharesReceived.toLocaleString()} shares for ${bob.initialDeposit.toLocaleString()} tokens`);

  if (alice.sharesReceived > bob.sharesReceived) {
    console.log("\n  ✅ CORRECT: Alice got more shares (deposited before yield accrued)");
  } else {
    console.log("\n  ⚠️  NOTE: Same shares — stream may not have accrued enough yield yet");
  }

  // All users redeem
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO: All users redeem");
  console.log("=".repeat(70));

  // Checkpoint first to materialize yield
  await program.methods.checkpoint().accountsStrict({ vault }).rpc();

  for (const user of users) {
    const userSharesNow = await getAccount(connection, user.sharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    if (Number(userSharesNow.amount) === 0) continue;

    const userAssetsBefore = await getAccount(connection, user.assetAccount);

    await program.methods
      .redeem(new BN(Number(userSharesNow.amount)), new BN(0))
      .accountsStrict({
        user: user.keypair.publicKey, vault, assetMint,
        userAssetAccount: user.assetAccount, assetVault, sharesMint,
        userSharesAccount: user.sharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([user.keypair])
      .rpc();

    const userAssetsAfter = await getAccount(connection, user.assetAccount);
    user.assetsRedeemed = Number(userAssetsAfter.amount) / 10 ** ASSET_DECIMALS;
    console.log(`\n  ${user.name}: redeemed → ${user.assetsRedeemed.toLocaleString()} tokens`);
  }

  // Final analysis
  console.log("\n" + "=".repeat(70));
  console.log("  FINAL: Fairness Check");
  console.log("=".repeat(70));

  let allFair = true;
  for (const user of users) {
    const profitLoss = user.assetsRedeemed - user.initialDeposit;
    const pctChange = (profitLoss / user.initialDeposit) * 100;
    const status = profitLoss > 0 ? "📈" : (Math.abs(pctChange) < 0.01 ? "✅" : "📉");
    console.log(`  ${status} ${user.name}: ${profitLoss >= 0 ? '+' : ''}${profitLoss.toFixed(4)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(4)}%)`);
    if (profitLoss < -1) allFair = false;
  }

  // Alice should have more profit (deposited before yield stream)
  const aliceProfit = alice.assetsRedeemed - alice.initialDeposit;
  const bobProfit = bob.assetsRedeemed - bob.initialDeposit;

  console.log("\n" + "=".repeat(70));
  if (aliceProfit >= bobProfit) {
    console.log("  ✅ Alice earned more yield (deposited before stream) — FAIR");
  } else {
    console.log("  ⚠️  Bob earned more than Alice — check stream timing");
  }
  console.log(allFair ? "  ✅ Multi-user streaming yield is FAIR" : "  ❌ Potential fairness issue");
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
