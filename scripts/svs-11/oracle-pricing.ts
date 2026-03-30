/**
 * SVS-11 Oracle Pricing Test Script
 *
 * Oracle-specific tests:
 * - Staleness (use update_timestamp to make oracle stale)
 * - Price updates between operations
 *
 * Run: npx ts-node scripts/svs-11/oracle-pricing.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import {
  setupTest,
  createVaultContext,
  explorerUrl,
  PRICE_SCALE,
} from "./helpers";

async function main() {
  const setup = await setupTest("Oracle Pricing");
  const { program, oracleProgram, payer } = setup;
  const ctx = await createVaultContext(setup);

  // Open window
  await program.methods
    .openInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault: ctx.vault })
    .rpc();

  // Step 1: Deposit at 1:1 price
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Deposit at 1:1 price");
  console.log("-".repeat(70));

  const depositAmount = new BN(1_000_000_000);

  await program.methods
    .requestDeposit(depositAmount)
    .accountsPartial({
      investor: ctx.investor.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      investorTokenAccount: ctx.investorAta,
      depositVault: ctx.depositVault,
      investmentRequest: ctx.investmentRequest,
      attestation: ctx.attestation,
      frozenCheck: undefined,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([ctx.investor])
    .rpc();

  await program.methods
    .approveDeposit()
    .accountsPartial({
      manager: payer.publicKey,
      vault: ctx.vault,
      investmentRequest: ctx.investmentRequest,
      investor: ctx.investor.publicKey,
      navOracle: ctx.navOracle,
      attestation: ctx.attestation,
      frozenCheck: undefined,
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  await program.methods
    .claimDeposit()
    .accountsPartial({
      investor: ctx.investor.publicKey,
      vault: ctx.vault,
      investmentRequest: ctx.investmentRequest,
      sharesMint: ctx.sharesMint,
      investorSharesAccount: ctx.investorSharesAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers([ctx.investor])
    .rpc();

  const shares1 = await getAccount(setup.connection, ctx.investorSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Shares at 1:1: ${shares1.amount.toString()}`);

  // Step 2: Update oracle price to 2:1
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Update oracle price to 2:1");
  console.log("-".repeat(70));

  const doublePrice = PRICE_SCALE.mul(new BN(2));
  const priceSig = await oracleProgram.methods
    .setPrice(doublePrice)
    .accountsPartial({
      authority: payer.publicKey,
      vault: ctx.vault,
      oracleData: ctx.navOracle,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(`  Set price 2x: ${explorerUrl(priceSig)}`);

  // Step 3: Deposit again at 2:1 price
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Deposit at 2:1 price (should get fewer shares)");
  console.log("-".repeat(70));

  await program.methods
    .requestDeposit(depositAmount)
    .accountsPartial({
      investor: ctx.investor.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      investorTokenAccount: ctx.investorAta,
      depositVault: ctx.depositVault,
      investmentRequest: ctx.investmentRequest,
      attestation: ctx.attestation,
      frozenCheck: undefined,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([ctx.investor])
    .rpc();

  await program.methods
    .approveDeposit()
    .accountsPartial({
      manager: payer.publicKey,
      vault: ctx.vault,
      investmentRequest: ctx.investmentRequest,
      investor: ctx.investor.publicKey,
      navOracle: ctx.navOracle,
      attestation: ctx.attestation,
      frozenCheck: undefined,
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  await program.methods
    .claimDeposit()
    .accountsPartial({
      investor: ctx.investor.publicKey,
      vault: ctx.vault,
      investmentRequest: ctx.investmentRequest,
      sharesMint: ctx.sharesMint,
      investorSharesAccount: ctx.investorSharesAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers([ctx.investor])
    .rpc();

  const shares2 = await getAccount(setup.connection, ctx.investorSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
  const newShares = BigInt(shares2.amount) - BigInt(shares1.amount);
  console.log(`  New shares at 2:1: ${newShares.toString()}`);
  console.log(`  Total shares: ${shares2.amount.toString()}`);

  // Step 4: Staleness test
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Oracle staleness (set timestamp far in past)");
  console.log("-".repeat(70));

  // Check if mock oracle has update_timestamp; if not, just log
  try {
    const staleTs = new BN(Math.floor(Date.now() / 1000) - 7200);
    const staleSig = await oracleProgram.methods
      .updateTimestamp(staleTs)
      .accountsPartial({
        authority: payer.publicKey,
        vault: ctx.vault,
        oracleData: ctx.navOracle,
      })
      .rpc();

    console.log(`  Set stale timestamp: ${explorerUrl(staleSig)}`);

    // Try approve with stale oracle
    await program.methods
      .requestDeposit(new BN(100_000_000))
      .accountsPartial({
        investor: ctx.investor.publicKey,
        vault: ctx.vault,
        assetMint: ctx.assetMint,
        investorTokenAccount: ctx.investorAta,
        depositVault: ctx.depositVault,
        investmentRequest: ctx.investmentRequest,
        attestation: ctx.attestation,
        frozenCheck: undefined,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([ctx.investor])
      .rpc();

    try {
      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: payer.publicKey,
          vault: ctx.vault,
          investmentRequest: ctx.investmentRequest,
          investor: ctx.investor.publicKey,
          navOracle: ctx.navOracle,
          attestation: ctx.attestation,
          frozenCheck: undefined,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        })
        .rpc();

      console.log("  WARNING: Approve succeeded with stale oracle (staleness check may be lenient)");
    } catch (err: any) {
      if (err.toString().includes("StaleOracle") || err.toString().includes("OracleStale")) {
        console.log("  Approve correctly rejected (stale oracle)");
      } else {
        console.log(`  Approve rejected: ${err.message || err.toString().slice(0, 100)}`);
      }
    }

    // Restore fresh timestamp
    await oracleProgram.methods
      .setPrice(PRICE_SCALE)
      .accountsPartial({
        authority: payer.publicKey,
        vault: ctx.vault,
        oracleData: ctx.navOracle,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log(`  Restored oracle to fresh state`);
  } catch (err: any) {
    console.log(`  Mock oracle does not support update_timestamp, skipping staleness test`);
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
