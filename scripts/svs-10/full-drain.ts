/**
 * SVS-10 Full Vault Drain Test
 *
 * Tests full vault drain via redemptions:
 * (a) Single user redeems all shares
 * (b) Multiple users redeem simultaneously draining vault to zero
 * (c) Verify vault state is clean after full drain
 * (d) New deposits work correctly after drain
 *
 * Run: npx ts-node scripts/svs-10/full-drain.ts
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

async function main() {
  const { connection, payer, provider, programId } = await baseSetup({
    testName: "Full Vault Drain",
    moduleName: "SVS-10",
    idlPath: path.join(__dirname, "../../target/idl/svs_10.json"),
    programKeypairPath: path.join(__dirname, "../../target/deploy/svs_10-keypair.json"),
    minBalanceSol: 2,
  });

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../../target/idl/svs_10.json"), "utf-8"));
  const program = new Program(idl, provider);

  console.log("--- Setup ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );

  await mintTo(connection, payer, assetMint, userAta.address, payer, 100_000_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getAsyncVaultAddress(programId, assetMint, vaultId);
  const [sharesMint] = getAsyncSharesMintAddress(programId, vault);
  const [shareEscrow] = getShareEscrowAddress(programId, vault);
  const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);

  await program.methods
    .initialize(vaultId, "Full Drain Test Vault", "DRAIN", "")
    .accounts({
      authority: payer.publicKey, operator: payer.publicKey, vault, assetMint,
      sharesMint, assetVault, shareEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  const userSharesAta = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log("  Setup complete\n");

  let passed = 0;
  let failed = 0;

  // ──────────────────────────────────────────────────────────────────────
  // TEST 1: Single user deposits, then redeems ALL shares
  // ──────────────────────────────────────────────────────────────────────
  console.log("-".repeat(70));
  console.log("TEST 1: Single user deposits and redeems all shares");
  console.log("-".repeat(70));

  const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
  const [depReq1] = getDepositRequestAddress(programId, vault, payer.publicKey);

  await program.methods
    .requestDeposit(depositAmount, payer.publicKey)
    .accounts({
      user: payer.publicKey, vault, assetMint,
      userAssetAccount: userAta.address, assetVault,
      depositRequest: depReq1,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  await program.methods
    .fulfillDeposit(null)
    .accountsStrict({
      operator: payer.publicKey, vault,
      depositRequest: depReq1,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: payer.publicKey, vault,
      depositRequest: depReq1,
      owner: payer.publicKey, sharesMint,
      receiverSharesAccount: userSharesAta,
      receiver: payer.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const sharesAfterDeposit = await getAccount(connection, userSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Deposited: 10,000 tokens`);
  console.log(`  Received: ${Number(sharesAfterDeposit.amount)} raw shares`);

  // Now redeem ALL shares
  const allShares = new BN(sharesAfterDeposit.amount.toString());
  const [redeemReq1] = getRedeemRequestAddress(programId, vault, payer.publicKey);

  await program.methods
    .requestRedeem(allShares, payer.publicKey)
    .accounts({
      user: payer.publicKey, vault, sharesMint,
      userSharesAccount: userSharesAta, shareEscrow,
      redeemRequest: redeemReq1,
      token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const [claimable1] = getClaimableTokensAddress(programId, vault, payer.publicKey);

  await program.methods
    .fulfillRedeem(null)
    .accountsStrict({
      operator: payer.publicKey, vault,
      redeemRequest: redeemReq1, operatorApproval: programId,
      assetMint, assetVault, sharesMint, shareEscrow,
      claimableTokens: claimable1,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  const assetsBefore = await getAccount(connection, userAta.address);

  await program.methods
    .claimRedeem()
    .accountsStrict({
      claimant: payer.publicKey, vault, assetMint,
      redeemRequest: redeemReq1, owner: payer.publicKey,
      claimableTokens: claimable1,
      receiverAssetAccount: userAta.address,
      receiver: payer.publicKey,
      operatorApproval: programId,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const assetsAfter = await getAccount(connection, userAta.address);
  const assetsReturned = (Number(assetsAfter.amount) - Number(assetsBefore.amount)) / 10 ** ASSET_DECIMALS;
  console.log(`  Assets returned: ${assetsReturned.toFixed(2)} tokens`);

  const vaultAfterDrain = await (program.account as any).asyncVault.fetch(vault);
  console.log(`  Vault total_assets: ${vaultAfterDrain.totalAssets.toNumber()}`);
  console.log(`  Vault total_shares: ${vaultAfterDrain.totalShares.toNumber()}`);

  if (vaultAfterDrain.totalAssets.toNumber() === 0 && vaultAfterDrain.totalShares.toNumber() === 0) {
    console.log("  PASSED: Vault fully drained (total_assets=0, total_shares=0)"); passed++;
  } else {
    console.log("  FAILED: Vault state not clean after full drain"); failed++;
  }

  // ──────────────────────────────────────────────────────────────────────
  // TEST 2: Multiple users drain simultaneously
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: Multiple users deposit, then all redeem to drain vault");
  console.log("-".repeat(70));

  const users = [
    { name: "User A", keypair: Keypair.generate(), deposit: 5_000 },
    { name: "User B", keypair: Keypair.generate(), deposit: 3_000 },
    { name: "User C", keypair: Keypair.generate(), deposit: 2_000 },
  ];

  await fundAccounts(connection, payer, users.map(u => u.keypair.publicKey), 0.05);

  // Create ATAs and mint tokens
  const userAccounts: { ata: PublicKey; sharesAta: PublicKey }[] = [];
  for (const user of users) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection, payer, assetMint, user.keypair.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
    );
    await mintTo(connection, payer, assetMint, ata.address, payer, user.deposit * 10 ** ASSET_DECIMALS);
    const sharesAta = getAssociatedTokenAddressSync(
      sharesMint, user.keypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    userAccounts.push({ ata: ata.address, sharesAta });
  }

  // All request deposits
  for (let i = 0; i < users.length; i++) {
    const [depReq] = getDepositRequestAddress(programId, vault, users[i].keypair.publicKey);
    await program.methods
      .requestDeposit(new BN(users[i].deposit * 10 ** ASSET_DECIMALS), users[i].keypair.publicKey)
      .accounts({
        user: users[i].keypair.publicKey, vault, assetMint,
        userAssetAccount: userAccounts[i].ata, assetVault,
        depositRequest: depReq,
        assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([users[i].keypair])
      .rpc();
    console.log(`  ${users[i].name} requested: ${users[i].deposit} tokens`);
  }

  // Fulfill all
  for (let i = 0; i < users.length; i++) {
    const [depReq] = getDepositRequestAddress(programId, vault, users[i].keypair.publicKey);
    await program.methods
      .fulfillDeposit(null)
      .accountsStrict({
        operator: payer.publicKey, vault,
        depositRequest: depReq,
        operatorApproval: programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  // Claim all
  for (let i = 0; i < users.length; i++) {
    const [depReq] = getDepositRequestAddress(programId, vault, users[i].keypair.publicKey);
    await program.methods
      .claimDeposit()
      .accountsStrict({
        claimant: users[i].keypair.publicKey, vault,
        depositRequest: depReq,
        owner: users[i].keypair.publicKey, sharesMint,
        receiverSharesAccount: userAccounts[i].sharesAta,
        receiver: users[i].keypair.publicKey,
        operatorApproval: programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([users[i].keypair])
      .rpc();
  }

  console.log("  All deposits claimed. Now redeeming all shares...");

  // All request redeem
  for (let i = 0; i < users.length; i++) {
    const sharesAcc = await getAccount(connection, userAccounts[i].sharesAta, undefined, TOKEN_2022_PROGRAM_ID);
    const [redeemReq] = getRedeemRequestAddress(programId, vault, users[i].keypair.publicKey);

    await program.methods
      .requestRedeem(new BN(sharesAcc.amount.toString()), users[i].keypair.publicKey)
      .accounts({
        user: users[i].keypair.publicKey, vault, sharesMint,
        userSharesAccount: userAccounts[i].sharesAta, shareEscrow,
        redeemRequest: redeemReq,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([users[i].keypair])
      .rpc();
  }

  // Fulfill all redeems
  for (let i = 0; i < users.length; i++) {
    const [redeemReq] = getRedeemRequestAddress(programId, vault, users[i].keypair.publicKey);
    const [claimableTokens] = getClaimableTokensAddress(programId, vault, users[i].keypair.publicKey);

    await program.methods
      .fulfillRedeem(null)
      .accountsStrict({
        operator: payer.publicKey, vault,
        redeemRequest: redeemReq, operatorApproval: programId,
        assetMint, assetVault, sharesMint, shareEscrow,
        claimableTokens,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId, clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  // Claim all redeems
  for (let i = 0; i < users.length; i++) {
    const [redeemReq] = getRedeemRequestAddress(programId, vault, users[i].keypair.publicKey);
    const [claimableTokens] = getClaimableTokensAddress(programId, vault, users[i].keypair.publicKey);

    await program.methods
      .claimRedeem()
      .accountsStrict({
        claimant: users[i].keypair.publicKey, vault, assetMint,
        redeemRequest: redeemReq, owner: users[i].keypair.publicKey,
        claimableTokens,
        receiverAssetAccount: userAccounts[i].ata,
        receiver: users[i].keypair.publicKey,
        operatorApproval: programId,
        assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([users[i].keypair])
      .rpc();

    const finalAssets = await getAccount(connection, userAccounts[i].ata);
    console.log(`  ${users[i].name} got back: ${Number(finalAssets.amount) / 10 ** ASSET_DECIMALS} tokens`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // TEST 3: Verify vault state is clean
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Verify vault state after multi-user drain");
  console.log("-".repeat(70));

  const vaultAfterMultiDrain = await (program.account as any).asyncVault.fetch(vault);
  const clean = vaultAfterMultiDrain.totalAssets.toNumber() === 0
    && vaultAfterMultiDrain.totalShares.toNumber() === 0
    && vaultAfterMultiDrain.totalPendingDeposits.toNumber() === 0;

  console.log(`  total_assets:           ${vaultAfterMultiDrain.totalAssets.toNumber()}`);
  console.log(`  total_shares:           ${vaultAfterMultiDrain.totalShares.toNumber()}`);
  console.log(`  total_pending_deposits: ${vaultAfterMultiDrain.totalPendingDeposits.toNumber()}`);

  if (clean) {
    console.log("  PASSED: Vault state is clean"); passed++;
  } else {
    console.log("  FAILED: Vault state has residual values"); failed++;
  }

  // ──────────────────────────────────────────────────────────────────────
  // TEST 4: New deposits work after full drain
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: New deposit works correctly after drain");
  console.log("-".repeat(70));

  const newDepositAmount = new BN(5_000 * 10 ** ASSET_DECIMALS);
  const [newDepReq] = getDepositRequestAddress(programId, vault, payer.publicKey);

  try {
    await program.methods
      .requestDeposit(newDepositAmount, payer.publicKey)
      .accounts({
        user: payer.publicKey, vault, assetMint,
        userAssetAccount: userAta.address, assetVault,
        depositRequest: newDepReq,
        assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .fulfillDeposit(null)
      .accountsStrict({
        operator: payer.publicKey, vault,
        depositRequest: newDepReq,
        operatorApproval: programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    await program.methods
      .claimDeposit()
      .accountsStrict({
        claimant: payer.publicKey, vault,
        depositRequest: newDepReq,
        owner: payer.publicKey, sharesMint,
        receiverSharesAccount: userSharesAta,
        receiver: payer.publicKey,
        operatorApproval: programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const postDrainVault = await (program.account as any).asyncVault.fetch(vault);
    const postShares = await getAccount(connection, userSharesAta, undefined, TOKEN_2022_PROGRAM_ID);

    console.log(`  New deposit: 5,000 tokens`);
    console.log(`  Shares received: ${Number(postShares.amount) / 10 ** SHARE_DECIMALS}`);
    console.log(`  Vault total_assets: ${postDrainVault.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
    console.log(`  Vault total_shares: ${postDrainVault.totalShares.toNumber() / 10 ** SHARE_DECIMALS}`);
    console.log("  PASSED: New deposits work after full drain"); passed++;
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`); failed++;
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/3 passed`);
  console.log(`  Full drain ${failed === 0 ? "WORKING" : "HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
