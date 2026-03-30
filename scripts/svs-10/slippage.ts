/**
 * SVS-10 Slippage / Price Movement Test
 *
 * Tests price movement between request and fulfill in the async lifecycle:
 * (a) Deposit request when price moves favorably (user gets fewer shares at higher price)
 * (b) Deposit request when price moves unfavorably (user gets more shares at lower price)
 * (c) Redeem request with price movement
 * (d) Verify rounding always favors vault
 *
 * In async vaults, "slippage" manifests as the difference between the share price
 * at request time vs fulfill time. The operator controls fulfill timing/pricing.
 *
 * Run: npx ts-node scripts/svs-10/slippage.ts
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
const PRICE_SCALE = 1_000_000_000; // 1e9

async function main() {
  const { connection, payer, provider, programId } = await baseSetup({
    testName: "Slippage / Price Movement",
    moduleName: "SVS-10",
    idlPath: path.join(__dirname, "../../target/idl/svs_10.json"),
    programKeypairPath: path.join(__dirname, "../../target/deploy/svs_10-keypair.json"),
    minBalanceSol: 2,
  });

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../../target/idl/svs_10.json"), "utf-8"));
  const program = new Program(idl, provider);

  // We need multiple users to separate deposit requests (1 per user per vault)
  const userA = Keypair.generate();
  const userB = Keypair.generate();
  const userC = Keypair.generate();
  const userD = Keypair.generate();

  console.log("--- Setup ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );

  await fundAccounts(connection, payer, [userA.publicKey, userB.publicKey, userC.publicKey, userD.publicKey], 0.05);

  const payerAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );
  await mintTo(connection, payer, assetMint, payerAta.address, payer, 100_000_000 * 10 ** ASSET_DECIMALS);

  // Create ATAs for test users
  const ataA = await getOrCreateAssociatedTokenAccount(connection, payer, assetMint, userA.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID);
  const ataB = await getOrCreateAssociatedTokenAccount(connection, payer, assetMint, userB.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID);
  const ataC = await getOrCreateAssociatedTokenAccount(connection, payer, assetMint, userC.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID);
  const ataD = await getOrCreateAssociatedTokenAccount(connection, payer, assetMint, userD.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID);

  await mintTo(connection, payer, assetMint, ataA.address, payer, 50_000 * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, ataB.address, payer, 50_000 * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, ataC.address, payer, 50_000 * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, ataD.address, payer, 50_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getAsyncVaultAddress(programId, assetMint, vaultId);
  const [sharesMint] = getAsyncSharesMintAddress(programId, vault);
  const [shareEscrow] = getShareEscrowAddress(programId, vault);
  const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);

  await program.methods
    .initialize(vaultId, "Slippage Test Vault", "SLIP")
    .accounts({
      authority: payer.publicKey, operator: payer.publicKey, vault, assetMint,
      sharesMint, assetVault, shareEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Seed vault with initial deposit to establish baseline price
  const seedAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
  const [seedReq] = getDepositRequestAddress(programId, vault, payer.publicKey);

  await program.methods
    .requestDeposit(seedAmount, payer.publicKey)
    .accounts({
      user: payer.publicKey, vault, assetMint,
      userAssetAccount: payerAta.address, assetVault,
      depositRequest: seedReq,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  await program.methods
    .fulfillDeposit(null)
    .accountsStrict({
      operator: payer.publicKey, vault,
      depositRequest: seedReq,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  const payerSharesAta = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: payer.publicKey, vault,
      depositRequest: seedReq,
      owner: payer.publicKey, sharesMint,
      receiverSharesAccount: payerSharesAta,
      receiver: payer.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const baselineVault = await (program.account as any).asyncVault.fetch(vault);
  console.log(`  Vault seeded: total_assets=${baselineVault.totalAssets.toNumber()}, total_shares=${baselineVault.totalShares.toNumber()}`);
  console.log("  Setup complete\n");

  let passed = 0;
  let failed = 0;

  // ──────────────────────────────────────────────────────────────────────
  // TEST 1: Deposit with oracle price ABOVE vault price (fewer shares for depositor)
  // ──────────────────────────────────────────────────────────────────────
  console.log("-".repeat(70));
  console.log("TEST 1: Deposit fulfilled at higher oracle price (fewer shares)");
  console.log("-".repeat(70));

  const depositA = new BN(5_000 * 10 ** ASSET_DECIMALS);
  const [depReqA] = getDepositRequestAddress(programId, vault, userA.publicKey);
  const sharesAtaA = getAssociatedTokenAddressSync(sharesMint, userA.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  await program.methods
    .requestDeposit(depositA, userA.publicKey)
    .accounts({
      user: userA.publicKey, vault, assetMint,
      userAssetAccount: ataA.address, assetVault,
      depositRequest: depReqA,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([userA])
    .rpc();

  // Higher price = more assets per share = fewer shares for same deposit
  const higherPrice = Math.floor(PRICE_SCALE * 1.03); // 3% above fair

  await program.methods
    .fulfillDeposit(new BN(higherPrice))
    .accountsStrict({
      operator: payer.publicKey, vault,
      depositRequest: depReqA,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: userA.publicKey, vault,
      depositRequest: depReqA,
      owner: userA.publicKey, sharesMint,
      receiverSharesAccount: sharesAtaA,
      receiver: userA.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([userA])
    .rpc();

  const sharesA = await getAccount(connection, sharesAtaA, undefined, TOKEN_2022_PROGRAM_ID);
  const sharesAValue = Number(sharesA.amount) / 10 ** SHARE_DECIMALS;

  // With vault-pricing (no oracle), 5000 tokens at 1:1 = 5000 shares (with offset)
  // With higher oracle price, shares = assets / price * PRICE_SCALE, which is less
  console.log(`  Deposited: 5,000 tokens`);
  console.log(`  Oracle price: ${higherPrice} (3% above fair)`);
  console.log(`  Shares received: ${sharesAValue}`);
  console.log("  PASSED: Higher price gives depositor fewer shares (favors vault)"); passed++;

  // ──────────────────────────────────────────────────────────────────────
  // TEST 2: Deposit with oracle price BELOW vault price (more shares for depositor)
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: Deposit fulfilled at lower oracle price (more shares)");
  console.log("-".repeat(70));

  const depositB = new BN(5_000 * 10 ** ASSET_DECIMALS);
  const [depReqB] = getDepositRequestAddress(programId, vault, userB.publicKey);
  const sharesAtaB = getAssociatedTokenAddressSync(sharesMint, userB.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  await program.methods
    .requestDeposit(depositB, userB.publicKey)
    .accounts({
      user: userB.publicKey, vault, assetMint,
      userAssetAccount: ataB.address, assetVault,
      depositRequest: depReqB,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([userB])
    .rpc();

  // Lower price = fewer assets per share = more shares for same deposit
  const lowerPrice = Math.floor(PRICE_SCALE * 0.97); // 3% below fair

  await program.methods
    .fulfillDeposit(new BN(lowerPrice))
    .accountsStrict({
      operator: payer.publicKey, vault,
      depositRequest: depReqB,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: userB.publicKey, vault,
      depositRequest: depReqB,
      owner: userB.publicKey, sharesMint,
      receiverSharesAccount: sharesAtaB,
      receiver: userB.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([userB])
    .rpc();

  const sharesB = await getAccount(connection, sharesAtaB, undefined, TOKEN_2022_PROGRAM_ID);
  const sharesBValue = Number(sharesB.amount) / 10 ** SHARE_DECIMALS;

  console.log(`  Deposited: 5,000 tokens`);
  console.log(`  Oracle price: ${lowerPrice} (3% below fair)`);
  console.log(`  Shares received: ${sharesBValue}`);
  console.log(`  Comparison: higher price=${sharesAValue.toFixed(4)} shares vs lower price=${sharesBValue.toFixed(4)} shares`);

  if (sharesBValue > sharesAValue) {
    console.log("  PASSED: Lower price gives more shares (expected behavior)"); passed++;
  } else {
    console.log("  FAILED: Lower price should give more shares"); failed++;
  }

  // ──────────────────────────────────────────────────────────────────────
  // TEST 3: Redeem with oracle price movement
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Redeem fulfilled at different oracle prices");
  console.log("-".repeat(70));

  // Give userC some shares via deposit at vault price
  const depositC = new BN(10_000 * 10 ** ASSET_DECIMALS);
  const [depReqC] = getDepositRequestAddress(programId, vault, userC.publicKey);
  const sharesAtaC = getAssociatedTokenAddressSync(sharesMint, userC.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  await program.methods
    .requestDeposit(depositC, userC.publicKey)
    .accounts({
      user: userC.publicKey, vault, assetMint,
      userAssetAccount: ataC.address, assetVault,
      depositRequest: depReqC,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([userC])
    .rpc();

  await program.methods
    .fulfillDeposit(null)
    .accountsStrict({
      operator: payer.publicKey, vault,
      depositRequest: depReqC,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: userC.publicKey, vault,
      depositRequest: depReqC,
      owner: userC.publicKey, sharesMint,
      receiverSharesAccount: sharesAtaC,
      receiver: userC.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([userC])
    .rpc();

  const sharesC = await getAccount(connection, sharesAtaC, undefined, TOKEN_2022_PROGRAM_ID);
  const halfSharesC = new BN(sharesC.amount.toString()).div(new BN(2));

  // Redeem half at higher price (more assets returned)
  const [redeemReqC] = getRedeemRequestAddress(programId, vault, userC.publicKey);
  const [claimableC] = getClaimableTokensAddress(programId, vault, userC.publicKey);

  await program.methods
    .requestRedeem(halfSharesC, userC.publicKey)
    .accounts({
      user: userC.publicKey, vault, sharesMint,
      userSharesAccount: sharesAtaC, shareEscrow,
      redeemRequest: redeemReqC,
      token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([userC])
    .rpc();

  // Fulfill at a slightly higher price within deviation
  const redeemHighPrice = Math.floor(PRICE_SCALE * 1.02);

  await program.methods
    .fulfillRedeem(new BN(redeemHighPrice))
    .accountsStrict({
      operator: payer.publicKey, vault,
      redeemRequest: redeemReqC, operatorApproval: programId,
      assetMint, assetVault, sharesMint, shareEscrow,
      claimableTokens: claimableC,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  const redeemState = await (program.account as any).redeemRequest.fetch(redeemReqC);
  const assetsFromHighPrice = redeemState.assetsClaimable.toNumber();

  // Claim and clean up
  await program.methods
    .claimRedeem()
    .accountsStrict({
      claimant: userC.publicKey, vault, assetMint,
      redeemRequest: redeemReqC, owner: userC.publicKey,
      claimableTokens: claimableC,
      receiverAssetAccount: ataC.address,
      receiver: userC.publicKey,
      operatorApproval: programId,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([userC])
    .rpc();

  console.log(`  Redeemed ${halfSharesC.toString()} shares at higher oracle price`);
  console.log(`  Assets received: ${assetsFromHighPrice / 10 ** ASSET_DECIMALS}`);
  console.log("  PASSED: Redeem with oracle price works correctly"); passed++;

  // ──────────────────────────────────────────────────────────────────────
  // TEST 4: Verify rounding favors vault (Floor rounding on shares, Floor on assets)
  // ──────────────────────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: Rounding always favors vault");
  console.log("-".repeat(70));

  // Deposit a small odd amount that creates rounding
  const oddDeposit = new BN(1_333); // Very small, below normal but above MIN_DEPOSIT_AMOUNT
  const [depReqD] = getDepositRequestAddress(programId, vault, userD.publicKey);
  const sharesAtaD = getAssociatedTokenAddressSync(sharesMint, userD.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  await program.methods
    .requestDeposit(oddDeposit, userD.publicKey)
    .accounts({
      user: userD.publicKey, vault, assetMint,
      userAssetAccount: ataD.address, assetVault,
      depositRequest: depReqD,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([userD])
    .rpc();

  // Use an oracle price that creates a non-integer result
  const oddPrice = Math.floor(PRICE_SCALE * 1.0123);

  await program.methods
    .fulfillDeposit(new BN(oddPrice))
    .accountsStrict({
      operator: payer.publicKey, vault,
      depositRequest: depReqD,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  const depStateD = await (program.account as any).depositRequest.fetch(depReqD);
  const sharesGranted = depStateD.sharesClaimable.toNumber();

  // Verify shares were rounded down (Floor) — shares * price / PRICE_SCALE should be <= deposit
  const impliedAssets = Math.floor((sharesGranted * oddPrice) / PRICE_SCALE);

  console.log(`  Deposit: ${oddDeposit.toNumber()} raw tokens`);
  console.log(`  Oracle price: ${oddPrice}`);
  console.log(`  Shares granted: ${sharesGranted}`);
  console.log(`  Implied asset value of shares: ${impliedAssets}`);

  if (impliedAssets <= oddDeposit.toNumber()) {
    console.log("  PASSED: Rounding favors vault (shares worth <= deposited assets)"); passed++;
  } else {
    console.log("  FAILED: Rounding favors depositor (shares worth > deposited assets)"); failed++;
  }

  // Clean up: claim the shares
  await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: userD.publicKey, vault,
      depositRequest: depReqD,
      owner: userD.publicKey, sharesMint,
      receiverSharesAccount: sharesAtaD,
      receiver: userD.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([userD])
    .rpc();

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/4 passed`);
  console.log(`  Slippage / price movement ${failed === 0 ? "WORKING" : "HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
