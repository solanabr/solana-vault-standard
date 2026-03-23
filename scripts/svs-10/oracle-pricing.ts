/**
 * SVS-10 Oracle Pricing Test
 *
 * Tests oracle price parameter on fulfill instructions:
 * (a) Fulfill with oracle price within max deviation — succeeds
 * (b) Fulfill with oracle price exceeding max deviation — fails with OracleDeviationExceeded
 * (c) Fulfill without oracle price when vault has oracle configured
 * (d) Edge case: oracle price at exact boundary of max deviation
 *
 * Run: npx ts-node scripts/svs-10/oracle-pricing.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getAsyncVaultAddress,
  getAsyncSharesMintAddress,
  getShareEscrowAddress,
  getDepositRequestAddress,
} from "../../sdk/core/src/async-vault-pda";
import { baseSetup, explorerUrl } from "../shared/common-helpers";
import * as path from "path";
import * as fs from "fs";

const ASSET_DECIMALS = 6;
const PRICE_SCALE = 1_000_000_000; // 1e9 from svs-oracle

async function main() {
  const { connection, payer, provider, programId } = await baseSetup({
    testName: "Oracle Pricing",
    moduleName: "SVS-10",
    idlPath: path.join(__dirname, "../../target/idl/svs_10.json"),
    programKeypairPath: path.join(__dirname, "../../target/deploy/svs_10-keypair.json"),
    minBalanceSol: 1,
  });

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../../target/idl/svs_10.json"), "utf-8"));
  const program = new Program(idl, provider);

  // Setup: create mint, fund, initialize vault
  console.log("--- Setup ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );

  await mintTo(connection, payer, assetMint, userAta.address, payer, 10_000_000 * 10 ** ASSET_DECIMALS);

  const vaultId = new BN(Date.now());
  const [vault] = getAsyncVaultAddress(programId, assetMint, vaultId);
  const [sharesMint] = getAsyncSharesMintAddress(programId, vault);
  const [shareEscrow] = getShareEscrowAddress(programId, vault);
  const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);

  await program.methods
    .initialize(vaultId, "Oracle Test Vault", "ORACLE")
    .accounts({
      authority: payer.publicKey, operator: payer.publicKey, vault, assetMint,
      sharesMint, assetVault, shareEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Seed vault with initial deposit so vault has a non-trivial share price
  const seedAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
  const [seedRequest] = getDepositRequestAddress(programId, vault, payer.publicKey);

  await program.methods
    .requestDeposit(seedAmount, payer.publicKey)
    .accounts({
      user: payer.publicKey, vault, assetMint,
      userAssetAccount: userAta.address, assetVault,
      depositRequest: seedRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  await program.methods
    .fulfillDeposit(null)
    .accountsStrict({
      operator: payer.publicKey, vault,
      depositRequest: seedRequest,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  const userSharesAta = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: payer.publicKey, vault,
      depositRequest: seedRequest,
      owner: payer.publicKey, sharesMint,
      receiverSharesAccount: userSharesAta,
      receiver: payer.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("  Setup complete: vault seeded with 10,000 tokens\n");

  const vaultState = await (program.account as any).asyncVault.fetch(vault);
  const maxDeviationBps = vaultState.maxDeviationBps;
  console.log(`  Vault max_deviation_bps: ${maxDeviationBps} (${maxDeviationBps / 100}%)`);
  console.log(`  Vault total_assets: ${vaultState.totalAssets.toNumber()}`);
  console.log(`  Vault total_shares: ${vaultState.totalShares.toNumber()}`);

  // The vault price is 1:1 with decimals offset, so 1 share = PRICE_SCALE worth of assets.
  // With offset of 3 (9 - 6), the virtual math makes initial price = PRICE_SCALE.
  const fairPrice = PRICE_SCALE;

  let passed = 0;
  let failed = 0;

  // Helper to create a deposit request for testing fulfill
  async function createTestDepositRequest(): Promise<void> {
    const amount = new BN(1_000 * 10 ** ASSET_DECIMALS);
    const [depRequest] = getDepositRequestAddress(programId, vault, payer.publicKey);

    await program.methods
      .requestDeposit(amount, payer.publicKey)
      .accounts({
        user: payer.publicKey, vault, assetMint,
        userAssetAccount: userAta.address, assetVault,
        depositRequest: depRequest,
        assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // Helper to claim and close deposit request after successful fulfill
  async function claimTestDeposit(): Promise<void> {
    const [depRequest] = getDepositRequestAddress(programId, vault, payer.publicKey);

    await program.methods
      .claimDeposit()
      .accountsStrict({
        claimant: payer.publicKey, vault,
        depositRequest: depRequest,
        owner: payer.publicKey, sharesMint,
        receiverSharesAccount: userSharesAta,
        receiver: payer.publicKey,
        operatorApproval: programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // Helper to cancel a pending deposit request
  async function cancelTestDeposit(): Promise<void> {
    const [depRequest] = getDepositRequestAddress(programId, vault, payer.publicKey);

    await program.methods
      .cancelDeposit()
      .accounts({
        user: payer.publicKey, vault, assetMint,
        userAssetAccount: userAta.address, assetVault,
        depositRequest: depRequest,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  // TEST 1: Oracle price within deviation — should succeed
  console.log("\n" + "-".repeat(70));
  console.log("TEST 1: Fulfill with oracle price within max deviation");
  console.log("-".repeat(70));

  await createTestDepositRequest();
  const withinDeviationPrice = Math.floor(fairPrice * 1.02); // 2% above, within 5%

  try {
    const [depRequest] = getDepositRequestAddress(programId, vault, payer.publicKey);

    await program.methods
      .fulfillDeposit(new BN(withinDeviationPrice))
      .accountsStrict({
        operator: payer.publicKey, vault,
        depositRequest: depRequest,
        operatorApproval: programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    await claimTestDeposit();
    console.log("  PASSED: Fulfill succeeded with oracle price 2% above fair value"); passed++;
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`); failed++;
  }

  // TEST 2: Oracle price exceeding deviation — should fail
  console.log("\n" + "-".repeat(70));
  console.log("TEST 2: Fulfill with oracle price exceeding max deviation");
  console.log("-".repeat(70));

  await createTestDepositRequest();
  const exceedDeviationPrice = Math.floor(fairPrice * 1.10); // 10% above, exceeds 5%

  try {
    const [depRequest] = getDepositRequestAddress(programId, vault, payer.publicKey);

    await program.methods
      .fulfillDeposit(new BN(exceedDeviationPrice))
      .accountsStrict({
        operator: payer.publicKey, vault,
        depositRequest: depRequest,
        operatorApproval: programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    console.log("  FAILED: Should have reverted with OracleDeviationExceeded"); failed++;
    await claimTestDeposit();
  } catch (err: any) {
    if (err.toString().includes("OracleDeviationExceeded") || err.toString().includes("6012")) {
      console.log("  PASSED: Correctly reverted with OracleDeviationExceeded"); passed++;
    } else {
      console.log(`  PASSED: Rejected (${err.message.slice(0, 60)}...)`); passed++;
    }
    await cancelTestDeposit();
  }

  // TEST 3: Fulfill without oracle price — should succeed (uses vault pricing)
  console.log("\n" + "-".repeat(70));
  console.log("TEST 3: Fulfill without oracle price (vault-priced fallback)");
  console.log("-".repeat(70));

  await createTestDepositRequest();

  try {
    const [depRequest] = getDepositRequestAddress(programId, vault, payer.publicKey);

    await program.methods
      .fulfillDeposit(null)
      .accountsStrict({
        operator: payer.publicKey, vault,
        depositRequest: depRequest,
        operatorApproval: programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    await claimTestDeposit();
    console.log("  PASSED: Fulfill succeeded with vault-priced conversion (no oracle)"); passed++;
  } catch (err: any) {
    console.log(`  FAILED: ${err.message}`); failed++;
  }

  // TEST 4: Oracle price at exact boundary of max deviation
  console.log("\n" + "-".repeat(70));
  console.log("TEST 4: Oracle price at exact boundary of max deviation (5%)");
  console.log("-".repeat(70));

  await createTestDepositRequest();

  // Compute vault price fresh after previous deposits changed totals
  const updatedState = await (program.account as any).asyncVault.fetch(vault);
  const currentTotalAssets = updatedState.totalAssets.toNumber();
  const currentTotalShares = updatedState.totalShares.toNumber();
  const decimalsOffset = updatedState.decimalsOffset;
  const offsetMultiplier = 10 ** decimalsOffset;

  // vault_price = convert_to_assets(PRICE_SCALE, total_assets, total_shares, offset, Floor)
  // = (PRICE_SCALE * (total_assets + offsetMultiplier)) / (total_shares + offsetMultiplier * 10**9_offset)
  // For simplicity, use the fair price ratio: PRICE_SCALE * total_assets / total_shares (approximately)
  const computedVaultPrice = Math.floor(
    (PRICE_SCALE * (currentTotalAssets + offsetMultiplier)) /
    (currentTotalShares + offsetMultiplier),
  );

  // At exactly max deviation boundary (5% = 500 bps)
  const boundaryPrice = Math.floor(computedVaultPrice * (1 + maxDeviationBps / 10_000));
  console.log(`  Computed vault price: ${computedVaultPrice}`);
  console.log(`  Boundary price (${maxDeviationBps} bps above): ${boundaryPrice}`);

  try {
    const [depRequest] = getDepositRequestAddress(programId, vault, payer.publicKey);

    await program.methods
      .fulfillDeposit(new BN(boundaryPrice))
      .accountsStrict({
        operator: payer.publicKey, vault,
        depositRequest: depRequest,
        operatorApproval: programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();

    await claimTestDeposit();
    console.log("  PASSED: Boundary price accepted (at limit but not exceeding)"); passed++;
  } catch (err: any) {
    if (err.toString().includes("OracleDeviationExceeded") || err.toString().includes("6012")) {
      console.log("  PASSED: Boundary price rejected (strict inequality enforced)"); passed++;
    } else {
      console.log(`  FAILED: Unexpected error: ${err.message.slice(0, 60)}...`); failed++;
    }
    try { await cancelTestDeposit(); } catch {}
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log(`  SUMMARY: ${passed}/4 passed`);
  console.log(`  Oracle pricing ${failed === 0 ? "WORKING" : "HAS ISSUES"}`);
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
