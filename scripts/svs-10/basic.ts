/**
 * SVS-10 Basic Test Script
 *
 * Tests the happy-path async vault lifecycle:
 * - Initialize vault
 * - Request deposit -> fulfill -> claim shares
 * - Request redeem -> fulfill -> claim assets
 *
 * Run: npx ts-node scripts/svs-10/basic.ts
 */

import { BN } from "@coral-xyz/anchor";
import { getAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  setupTest,
  createAndInitializeVault,
  depositCycle,
  redeemCycle,
  explorerUrl,
  printSummary,
} from "./helpers";

async function main() {
  const setup = await setupTest("Basic Lifecycle");
  const { connection } = setup;

  const results: { step: string; sig: string }[] = [];

  // Step 1: Create asset mint & initialize vault
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Creating asset mint and initializing vault");
  console.log("-".repeat(70));

  const ctx = await createAndInitializeVault(setup);

  // Step 2: Deposit cycle (1,000 tokens)
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Deposit cycle (request -> fulfill -> claim)");
  console.log("-".repeat(70));

  const depositAmount = new BN(1_000_000_000);
  const dep = await depositCycle(setup, ctx, depositAmount);

  results.push({ step: "Request deposit", sig: dep.reqSig });
  results.push({ step: "Fulfill deposit", sig: dep.fulSig });
  results.push({ step: "Claim deposit", sig: dep.claimSig });

  const sharesAccount = await getAccount(connection, ctx.userSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Shares received: ${sharesAccount.amount.toString()}`);
  console.log(`  OK: ${explorerUrl(dep.claimSig)}`);

  // Step 3: Redeem cycle (half of shares)
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Redeem cycle (request -> fulfill -> claim)");
  console.log("-".repeat(70));

  const redeemShares = new BN(sharesAccount.amount.toString()).div(new BN(2));
  const red = await redeemCycle(setup, ctx, redeemShares);

  results.push({ step: "Request redeem", sig: red.reqSig });
  results.push({ step: "Fulfill redeem", sig: red.fulSig });
  results.push({ step: "Claim redeem", sig: red.claimSig });

  console.log(`  Shares redeemed: ${redeemShares.toString()}`);
  console.log(`  OK: ${explorerUrl(red.claimSig)}`);

  printSummary(results, ctx.vault, setup.programId);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
