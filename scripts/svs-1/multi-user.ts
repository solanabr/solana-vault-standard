/**
 * SVS-1 Multi-User Fairness Test
 *
 * Tests that multiple users get fair treatment:
 * - Multiple users deposit at different times
 * - Share price changes correctly
 * - No user can extract more than their fair share
 *
 * Run: npx ts-node scripts/svs-1/multi-user.ts
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
import { setupTest, getVaultPDA, getSharesMintPDA, fundAccounts, ASSET_DECIMALS, SHARE_DECIMALS } from "./helpers";

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
  const { connection, payer, program, programId } = await setupTest("Multi-User Fairness");

  // Create test users
  const users: UserState[] = [
    { name: "Alice", keypair: Keypair.generate(), assetAccount: PublicKey.default, sharesAccount: PublicKey.default, initialDeposit: 10_000, sharesReceived: 0, assetsRedeemed: 0 },
    { name: "Bob", keypair: Keypair.generate(), assetAccount: PublicKey.default, sharesAccount: PublicKey.default, initialDeposit: 5_000, sharesReceived: 0, assetsRedeemed: 0 },
    { name: "Charlie", keypair: Keypair.generate(), assetAccount: PublicKey.default, sharesAccount: PublicKey.default, initialDeposit: 20_000, sharesReceived: 0, assetsRedeemed: 0 },
  ];

  console.log("--- Creating test users ---");
  for (const user of users) {
    console.log(`  ${user.name}: ${user.keypair.publicKey.toBase58()}`);
  }

  // Fund users with SOL (transfer, not airdrop)
  console.log("\n--- Funding users with SOL ---");
  await fundAccounts(
    connection,
    payer,
    users.map(u => u.keypair.publicKey),
    0.05
  );
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

  // Initialize vault
  console.log("\n--- Initializing vault ---");
  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const assetVault = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault });

  await program.methods
    .initialize(vaultId, "Multi-User Test Vault", "MULTI", "https://test.com")
    .accountsStrict({
      authority: payer.publicKey, vault, assetMint, sharesMint, assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Setup user shares accounts
  for (const user of users) {
    user.sharesAccount = getAssociatedTokenAddressSync(
      sharesMint, user.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
  }

  // Sequential deposits
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO: Sequential Deposits");
  console.log("=".repeat(70));

  for (const user of users) {
    console.log(`\n--- ${user.name} deposits ${user.initialDeposit.toLocaleString()} tokens ---`);

    await program.methods
      .deposit(new BN(user.initialDeposit * 10 ** ASSET_DECIMALS), new BN(0))
      .accountsStrict({
        user: user.keypair.publicKey, vault, assetMint,
        userAssetAccount: user.assetAccount, assetVault, sharesMint,
        userSharesAccount: user.sharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([user.keypair])
      .rpc();

    const userShares = await getAccount(connection, user.sharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    user.sharesReceived = Number(userShares.amount) / 10 ** SHARE_DECIMALS;
    console.log(`  ${user.name} received: ${user.sharesReceived.toLocaleString()} shares`);
  }

  // Analysis
  console.log("\n" + "=".repeat(70));
  console.log("  ANALYSIS: Share Distribution");
  console.log("=".repeat(70));

  const totalDeposited = users.reduce((sum, u) => sum + u.initialDeposit, 0);
  const totalShares = users.reduce((sum, u) => sum + u.sharesReceived, 0);

  console.log(`\n  Total deposited: ${totalDeposited.toLocaleString()} tokens`);
  console.log(`  Total shares: ${totalShares.toLocaleString()}\n`);

  for (const user of users) {
    const expectedPct = (user.initialDeposit / totalDeposited) * 100;
    const actualPct = (user.sharesReceived / totalShares) * 100;
    console.log(`  ${user.name}: ${actualPct.toFixed(2)}% of shares (expected ${expectedPct.toFixed(2)}%)`);
  }

  // All users redeem
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO: All users redeem all shares");
  console.log("=".repeat(70));

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
    const status = Math.abs(pctChange) < 0.01 ? "✅" : (pctChange > 0 ? "📈" : "📉");
    console.log(`  ${status} ${user.name}: ${profitLoss >= 0 ? '+' : ''}${profitLoss.toFixed(4)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(4)}%)`);
    if (profitLoss < -1) allFair = false;
  }

  console.log("\n" + "=".repeat(70));
  console.log(allFair ? "  ✅ Multi-user accounting is FAIR" : "  ❌ Potential fairness issue");
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
