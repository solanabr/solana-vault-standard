/**
 * SVS-5 Full Drain Test
 *
 * Tests vault draining scenarios with streaming yield:
 * 1. Single user: deposit → stream yield → checkpoint → redeem all → vault empty
 * 2. Multi-user: stream yield → all redeem → vault drained
 * 3. Re-deposit after drain works
 *
 * Run: npx ts-node scripts/svs-5/full-drain.ts
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

async function main() {
  const { connection, payer, program, programId } = await setupTest("Full Drain");

  let passed = 0;
  let failed = 0;

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  await mintTo(connection, payer, assetMint, userAta.address, payer, 1_000_000 * 10 ** ASSET_DECIMALS);

  // ============================================================================
  // TEST 1: Single user full drain after stream completes
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 1: Single User Full Drain (After Stream)");
  console.log("=".repeat(70));

  const vaultId1 = new BN(Date.now());
  const [vault1] = getVaultPDA(programId, assetMint, vaultId1);
  const [sharesMint1] = getSharesMintPDA(programId, vault1);
  const assetVault1 = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault1 });
  const userSharesAccount1 = getAssociatedTokenAddressSync(
    sharesMint1, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  await program.methods
    .initialize(vaultId1)
    .accountsStrict({
      authority: payer.publicKey, vault: vault1, assetMint, sharesMint: sharesMint1, assetVault: assetVault1,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  const depositAmount = 50_000 * 10 ** ASSET_DECIMALS;
  const assetsBefore = Number((await getAccount(connection, userAta.address)).amount);

  // Deposit
  await program.methods
    .deposit(new BN(depositAmount), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault: vault1, assetMint, userAssetAccount: userAta.address,
      assetVault: assetVault1, sharesMint: sharesMint1, userSharesAccount: userSharesAccount1,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint1)])
    .rpc();

  // Distribute yield (short stream for testing)
  await program.methods
    .distributeYield(new BN(5_000 * 10 ** ASSET_DECIMALS), new BN(60))
    .accountsStrict({
      authority: payer.publicKey, vault: vault1, assetMint,
      authorityAssetAccount: userAta.address, assetVault: assetVault1,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log(`\n  Deposited: ${depositAmount / 10 ** ASSET_DECIMALS} tokens`);
  console.log("  Yield stream: 5,000 tokens over 60s");

  // Wait for stream to finish
  console.log("  Waiting 65s for stream to complete...");
  await new Promise(r => setTimeout(r, 65000));

  // Checkpoint to finalize
  await program.methods.checkpoint().accountsStrict({ vault: vault1 }).rpc();

  const userShares = await getAccount(connection, userSharesAccount1, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Shares: ${Number(userShares.amount) / 10 ** SHARE_DECIMALS}`);

  // Redeem ALL shares
  await program.methods
    .redeem(new BN(Number(userShares.amount)), new BN(0))
    .accountsStrict({
      user: payer.publicKey, vault: vault1, assetMint, userAssetAccount: userAta.address,
      assetVault: assetVault1, sharesMint: sharesMint1, userSharesAccount: userSharesAccount1,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();

  const vaultBalance1 = await getAccount(connection, assetVault1);
  const sharesSupply1 = await getMint(connection, sharesMint1, undefined, TOKEN_2022_PROGRAM_ID);
  const assetsAfter = Number((await getAccount(connection, userAta.address)).amount);
  const assetsRecovered = assetsAfter - assetsBefore;

  console.log(`  Vault balance after drain: ${Number(vaultBalance1.amount)}`);
  console.log(`  Shares supply after drain: ${Number(sharesSupply1.supply)}`);
  console.log(`  Assets recovered: ${assetsRecovered / 10 ** ASSET_DECIMALS} (deposit + yield = ${(depositAmount + 5_000 * 10 ** ASSET_DECIMALS) / 10 ** ASSET_DECIMALS})`);

  // Vault may retain dust (≤1 lamport) due to rounding in favor of vault — this is expected
  if (Number(vaultBalance1.amount) <= 1 && Number(sharesSupply1.supply) === 0) {
    console.log("  ✅ PASSED: Vault fully drained (dust ≤1 lamport is expected from vault-favoring rounding)");
    passed++;
  } else {
    console.log("  ❌ FAILED: Vault not fully drained");
    failed++;
  }

  // ============================================================================
  // TEST 2: Multi-user full drain with streaming yield
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 2: Multi-User Full Drain (With Streaming Yield)");
  console.log("=".repeat(70));

  const vaultId2 = new BN(Date.now() + 1);
  const [vault2] = getVaultPDA(programId, assetMint, vaultId2);
  const [sharesMint2] = getSharesMintPDA(programId, vault2);
  const assetVault2 = anchor.utils.token.associatedAddress({ mint: assetMint, owner: vault2 });

  await program.methods
    .initialize(vaultId2)
    .accountsStrict({
      authority: payer.publicKey, vault: vault2, assetMint, sharesMint: sharesMint2, assetVault: assetVault2,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  const users = [
    { name: "Alice", keypair: Keypair.generate(), deposit: 10_000 },
    { name: "Bob", keypair: Keypair.generate(), deposit: 5_000 },
    { name: "Charlie", keypair: Keypair.generate(), deposit: 20_000 },
  ];

  await fundAccounts(connection, payer, users.map(u => u.keypair.publicKey), 0.05);

  for (const user of users) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection, payer, assetMint, user.keypair.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
    );
    await mintTo(connection, payer, assetMint, ata.address, payer, user.deposit * 10 ** ASSET_DECIMALS);

    const sharesAccount = getAssociatedTokenAddressSync(
      sharesMint2, user.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await program.methods
      .deposit(new BN(user.deposit * 10 ** ASSET_DECIMALS), new BN(0))
      .accountsStrict({
        user: user.keypair.publicKey, vault: vault2, assetMint,
        userAssetAccount: ata.address, assetVault: assetVault2, sharesMint: sharesMint2,
        userSharesAccount: sharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createSharesAtaIx(user.keypair.publicKey, user.keypair.publicKey, sharesMint2)])
      .signers([user.keypair])
      .rpc();

    console.log(`  ${user.name} deposited ${user.deposit.toLocaleString()} tokens`);
  }

  // Distribute yield and wait for completion
  await program.methods
    .distributeYield(new BN(3_000 * 10 ** ASSET_DECIMALS), new BN(60))
    .accountsStrict({
      authority: payer.publicKey, vault: vault2, assetMint,
      authorityAssetAccount: userAta.address, assetVault: assetVault2,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("\n  Yield stream: 3,000 tokens over 60s");
  console.log("  Waiting 65s for stream to complete...");
  await new Promise(r => setTimeout(r, 65000));

  // Checkpoint
  await program.methods.checkpoint().accountsStrict({ vault: vault2 }).rpc();

  // All users redeem
  console.log("\n  All users redeeming...");
  for (const user of users) {
    const sharesAccount = getAssociatedTokenAddressSync(
      sharesMint2, user.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const ata = await getOrCreateAssociatedTokenAccount(
      connection, payer, assetMint, user.keypair.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
    );

    const shares = await getAccount(connection, sharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    if (Number(shares.amount) === 0) continue;

    await program.methods
      .redeem(new BN(Number(shares.amount)), new BN(0))
      .accountsStrict({
        user: user.keypair.publicKey, vault: vault2, assetMint,
        userAssetAccount: ata.address, assetVault: assetVault2, sharesMint: sharesMint2,
        userSharesAccount: sharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([user.keypair])
      .rpc();

    const userAssets = await getAccount(connection, ata.address);
    console.log(`  ${user.name} redeemed → ${(Number(userAssets.amount) / 10 ** ASSET_DECIMALS).toLocaleString()} tokens`);
  }

  const vaultBalance2 = await getAccount(connection, assetVault2);
  const sharesSupply2 = await getMint(connection, sharesMint2, undefined, TOKEN_2022_PROGRAM_ID);

  console.log(`\n  Vault balance: ${Number(vaultBalance2.amount)}`);
  console.log(`  Shares supply: ${Number(sharesSupply2.supply)}`);

  // Vault may retain dust (≤1 lamport) due to rounding in favor of vault — this is expected
  if (Number(vaultBalance2.amount) <= 1 && Number(sharesSupply2.supply) === 0) {
    console.log("  ✅ PASSED: Multi-user vault fully drained (dust ≤1 lamport is expected)");
    passed++;
  } else {
    console.log("  ❌ FAILED: Vault not fully drained");
    failed++;
  }

  // ============================================================================
  // TEST 3: Re-deposit after drain
  // ============================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  TEST 3: Re-deposit After Drain");
  console.log("=".repeat(70));

  const userSharesAccount1Again = getAssociatedTokenAddressSync(
    sharesMint1, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  try {
    await program.methods
      .deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(0))
      .accountsStrict({
        user: payer.publicKey, vault: vault1, assetMint, userAssetAccount: userAta.address,
        assetVault: assetVault1, sharesMint: sharesMint1, userSharesAccount: userSharesAccount1Again,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint1)])
      .rpc();

    const newShares = await getAccount(connection, userSharesAccount1Again, undefined, TOKEN_2022_PROGRAM_ID);
    const newVaultBalance = await getAccount(connection, assetVault1);

    console.log(`\n  Re-deposited: 10,000 tokens`);
    console.log(`  New shares: ${Number(newShares.amount) / 10 ** SHARE_DECIMALS}`);
    console.log(`  New vault balance: ${Number(newVaultBalance.amount) / 10 ** ASSET_DECIMALS}`);

    if (Number(newShares.amount) > 0 && Number(newVaultBalance.amount) > 0) {
      console.log("  ✅ PASSED: Re-deposit after drain works");
      passed++;
    } else {
      console.log("  ❌ FAILED: Re-deposit produced no shares or balance");
      failed++;
    }
  } catch (err: any) {
    console.log(`  ❌ FAILED: ${err.message}`);
    failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/${passed + failed} passed`);
  console.log(`  Full drain ${failed === 0 ? "✅ WORKING" : "❌ HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
