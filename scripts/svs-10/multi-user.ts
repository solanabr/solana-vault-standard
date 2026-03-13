/**
 * SVS-10 Multi-User Concurrent Requests Test
 *
 * Tests concurrent requests from multiple users through async lifecycle:
 * (a) Multiple users request deposits simultaneously
 * (b) Operator fulfills them in different order
 * (c) Users claim independently
 * (d) Verify share prices are consistent across all users
 * (e) No cross-contamination between user requests
 *
 * Run: npx ts-node scripts/svs-10/multi-user.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getAsyncVaultAddress,
  getAsyncSharesMintAddress,
  getShareEscrowAddress,
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableTokensAddress,
} from "../../sdk/core/src/async-vault-pda";
import { baseSetup, fundAccounts, explorerUrl } from "../shared/common-helpers";
import * as path from "path";
import * as fs from "fs";

const ASSET_DECIMALS = 6;
const SHARE_DECIMALS = 9;

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
  const { connection, payer, provider, programId } = await baseSetup({
    testName: "Multi-User Concurrent Requests",
    moduleName: "SVS-10",
    idlPath: path.join(__dirname, "../../target/idl/svs_10.json"),
    programKeypairPath: path.join(__dirname, "../../target/deploy/svs_10-keypair.json"),
    minBalanceSol: 2,
  });

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../../target/idl/svs_10.json"), "utf-8"));
  const program = new Program(idl, provider);

  const users: UserState[] = [
    { name: "Alice", keypair: Keypair.generate(), assetAccount: PublicKey.default, sharesAccount: PublicKey.default, initialDeposit: 10_000, sharesReceived: 0, assetsRedeemed: 0 },
    { name: "Bob", keypair: Keypair.generate(), assetAccount: PublicKey.default, sharesAccount: PublicKey.default, initialDeposit: 5_000, sharesReceived: 0, assetsRedeemed: 0 },
    { name: "Charlie", keypair: Keypair.generate(), assetAccount: PublicKey.default, sharesAccount: PublicKey.default, initialDeposit: 20_000, sharesReceived: 0, assetsRedeemed: 0 },
  ];

  console.log("--- Creating test users ---");
  for (const user of users) {
    console.log(`  ${user.name}: ${user.keypair.publicKey.toBase58()}`);
  }

  console.log("\n--- Funding users with SOL ---");
  await fundAccounts(connection, payer, users.map(u => u.keypair.publicKey), 0.05);
  console.log("  All users funded with 0.05 SOL");

  console.log("\n--- Creating test token ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );

  console.log("\n--- Setting up user token accounts ---");
  for (const user of users) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection, payer, assetMint, user.keypair.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
    );
    user.assetAccount = ata.address;
    await mintTo(connection, payer, assetMint, user.assetAccount, payer, user.initialDeposit * 10 ** ASSET_DECIMALS);
    console.log(`  ${user.name}: ${user.initialDeposit.toLocaleString()} tokens`);
  }

  // Initialize vault
  console.log("\n--- Initializing vault ---");
  const vaultId = new BN(Date.now());
  const [vault] = getAsyncVaultAddress(programId, assetMint, vaultId);
  const [sharesMint] = getAsyncSharesMintAddress(programId, vault);
  const [shareEscrow] = getShareEscrowAddress(programId, vault);
  const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);

  await program.methods
    .initialize(vaultId, "Multi-User Test Vault", "MULTI", "")
    .accounts({
      authority: payer.publicKey, operator: payer.publicKey, vault, assetMint,
      sharesMint, assetVault, shareEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  for (const user of users) {
    user.sharesAccount = getAssociatedTokenAddressSync(
      sharesMint, user.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  // SCENARIO 1: All users request deposits simultaneously
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO 1: Simultaneous Deposit Requests");
  console.log("=".repeat(70));

  for (const user of users) {
    const amount = new BN(user.initialDeposit * 10 ** ASSET_DECIMALS);
    const [depRequest] = getDepositRequestAddress(programId, vault, user.keypair.publicKey);

    await program.methods
      .requestDeposit(amount, user.keypair.publicKey)
      .accounts({
        user: user.keypair.publicKey, vault, assetMint,
        userAssetAccount: user.assetAccount, assetVault,
        depositRequest: depRequest,
        assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([user.keypair])
      .rpc();

    console.log(`  ${user.name} requested deposit: ${user.initialDeposit.toLocaleString()} tokens`);
  }

  // SCENARIO 2: Operator fulfills in REVERSE order (Charlie, Bob, Alice)
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO 2: Fulfill in Reverse Order (Charlie, Bob, Alice)");
  console.log("=".repeat(70));

  const fulfillOrder = [...users].reverse();
  for (const user of fulfillOrder) {
    const [depRequest] = getDepositRequestAddress(programId, vault, user.keypair.publicKey);

    await program.methods
      .fulfillDeposit(null)
      .accountsStrict({
        operator: payer.publicKey, vault,
        depositRequest: depRequest,
        operatorApproval: programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    const depState = await (program.account as any).depositRequest.fetch(depRequest);
    console.log(`  Fulfilled ${user.name}: ${depState.sharesClaimable.toString()} shares claimable`);
  }

  // SCENARIO 3: Users claim in original order (Alice, Bob, Charlie)
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO 3: Users Claim Independently");
  console.log("=".repeat(70));

  for (const user of users) {
    const [depRequest] = getDepositRequestAddress(programId, vault, user.keypair.publicKey);

    await program.methods
      .claimDeposit()
      .accountsStrict({
        claimant: user.keypair.publicKey, vault,
        depositRequest: depRequest,
        owner: user.keypair.publicKey, sharesMint,
        receiverSharesAccount: user.sharesAccount,
        receiver: user.keypair.publicKey,
        operatorApproval: programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user.keypair])
      .rpc();

    const sharesAcc = await getAccount(connection, user.sharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    user.sharesReceived = Number(sharesAcc.amount) / 10 ** SHARE_DECIMALS;
    console.log(`  ${user.name} claimed: ${user.sharesReceived.toLocaleString()} shares`);
  }

  // SCENARIO 4: Share price consistency
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO 4: Share Price Consistency");
  console.log("=".repeat(70));

  const totalDeposited = users.reduce((sum, u) => sum + u.initialDeposit, 0);
  const totalShares = users.reduce((sum, u) => sum + u.sharesReceived, 0);

  console.log(`\n  Total deposited: ${totalDeposited.toLocaleString()} tokens`);
  console.log(`  Total shares: ${totalShares.toLocaleString()}\n`);

  let allConsistent = true;
  for (const user of users) {
    const expectedPct = (user.initialDeposit / totalDeposited) * 100;
    const actualPct = (user.sharesReceived / totalShares) * 100;
    const deviation = Math.abs(expectedPct - actualPct);
    const status = deviation < 0.01 ? "OK" : "DRIFT";
    console.log(`  ${status} ${user.name}: ${actualPct.toFixed(4)}% of shares (expected ${expectedPct.toFixed(4)}%, deviation ${deviation.toFixed(6)}%)`);
    if (deviation > 0.1) allConsistent = false;
  }

  // SCENARIO 5: Cross-contamination check via full redeem
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO 5: Full Redeem — No Cross-Contamination");
  console.log("=".repeat(70));

  for (const user of users) {
    const sharesAcc = await getAccount(connection, user.sharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    if (Number(sharesAcc.amount) === 0) continue;

    const [redeemRequest] = getRedeemRequestAddress(programId, vault, user.keypair.publicKey);

    await program.methods
      .requestRedeem(new BN(sharesAcc.amount.toString()), user.keypair.publicKey)
      .accounts({
        user: user.keypair.publicKey, vault, sharesMint,
        userSharesAccount: user.sharesAccount, shareEscrow,
        redeemRequest,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([user.keypair])
      .rpc();

    console.log(`  ${user.name} requested redeem: ${Number(sharesAcc.amount)} raw shares`);
  }

  // Fulfill all redeems
  for (const user of users) {
    const [redeemRequest] = getRedeemRequestAddress(programId, vault, user.keypair.publicKey);
    const [claimableTokens] = getClaimableTokensAddress(programId, vault, user.keypair.publicKey);

    await program.methods
      .fulfillRedeem(null)
      .accountsStrict({
        operator: payer.publicKey, vault,
        redeemRequest, operatorApproval: programId,
        assetMint, assetVault, sharesMint, shareEscrow,
        claimableTokens,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId, clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    console.log(`  Fulfilled ${user.name}'s redeem`);
  }

  // Claim all redeems
  for (const user of users) {
    const [redeemRequest] = getRedeemRequestAddress(programId, vault, user.keypair.publicKey);
    const [claimableTokens] = getClaimableTokensAddress(programId, vault, user.keypair.publicKey);

    const assetsBefore = await getAccount(connection, user.assetAccount);

    await program.methods
      .claimRedeem()
      .accountsStrict({
        claimant: user.keypair.publicKey, vault, assetMint,
        redeemRequest, owner: user.keypair.publicKey,
        claimableTokens,
        receiverAssetAccount: user.assetAccount,
        receiver: user.keypair.publicKey,
        operatorApproval: programId,
        assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([user.keypair])
      .rpc();

    const assetsAfter = await getAccount(connection, user.assetAccount);
    user.assetsRedeemed = Number(assetsAfter.amount) / 10 ** ASSET_DECIMALS;
    console.log(`  ${user.name} redeemed: ${user.assetsRedeemed.toLocaleString()} tokens`);
  }

  // Final fairness check
  console.log("\n" + "=".repeat(70));
  console.log("  FINAL: Fairness Check");
  console.log("=".repeat(70));

  let allFair = true;
  for (const user of users) {
    const profitLoss = user.assetsRedeemed - user.initialDeposit;
    const pctChange = (profitLoss / user.initialDeposit) * 100;
    const status = Math.abs(pctChange) < 0.01 ? "OK" : (profitLoss > 0 ? "PROFIT" : "LOSS");
    console.log(`  ${status} ${user.name}: ${profitLoss >= 0 ? '+' : ''}${profitLoss.toFixed(4)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(4)}%)`);
    if (profitLoss < -1) allFair = false;
  }

  // Verify vault state is clean
  const finalVault = await (program.account as any).asyncVault.fetch(vault);
  console.log(`\n  Vault total_assets after full drain: ${finalVault.totalAssets.toNumber()}`);
  console.log(`  Vault total_shares after full drain: ${finalVault.totalShares.toNumber()}`);

  console.log("\n" + "=".repeat(70));
  const status = allFair && allConsistent ? "PASSED" : "HAS ISSUES";
  console.log(`  Multi-user accounting: ${status}`);
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
