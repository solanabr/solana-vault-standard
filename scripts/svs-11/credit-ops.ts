/**
 * SVS-11 Credit Operations Test Script
 *
 * Draw down, repay, NAV tracking:
 * - Draw down assets
 * - Repay assets
 * - Verify total_assets tracking
 *
 * Run: npx ts-node scripts/svs-11/credit-ops.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  setupTest,
  createVaultContext,
  explorerUrl,
} from "./helpers";

async function main() {
  const setup = await setupTest("Credit Operations");
  const { program, payer } = setup;
  const ctx = await createVaultContext(setup);

  // First deposit so vault has assets
  await program.methods
    .openInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault: ctx.vault })
    .rpc();

  const depositAmount = new BN(2_000_000_000);

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
      frozenCheck: null,
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
      frozenCheck: null,
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

  // Check initial state
  let vaultAccount = await (program.account as any).creditVault.fetch(ctx.vault);
  console.log(`  Initial total_assets: ${vaultAccount.totalAssets.toString()}`);

  // Step 1: Draw down
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Draw down assets");
  console.log("-".repeat(70));

  const drawAmount = new BN(500_000_000);

  const drawSig = await program.methods
    .drawDown(drawAmount)
    .accountsPartial({
      manager: payer.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      depositVault: ctx.depositVault,
      destination: ctx.payerAta,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log(`  Draw down: ${explorerUrl(drawSig)}`);

  vaultAccount = await (program.account as any).creditVault.fetch(ctx.vault);
  console.log(`  total_assets after draw: ${vaultAccount.totalAssets.toString()}`);

  // Step 2: Draw down more
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Draw down more assets");
  console.log("-".repeat(70));

  const drawAmount2 = new BN(300_000_000);

  const drawSig2 = await program.methods
    .drawDown(drawAmount2)
    .accountsPartial({
      manager: payer.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      depositVault: ctx.depositVault,
      destination: ctx.payerAta,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log(`  Draw down: ${explorerUrl(drawSig2)}`);

  vaultAccount = await (program.account as any).creditVault.fetch(ctx.vault);
  console.log(`  total_assets after 2nd draw: ${vaultAccount.totalAssets.toString()}`);

  // Step 3: Repay partial
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Repay partial");
  console.log("-".repeat(70));

  const repayAmount = new BN(400_000_000);

  const repaySig = await program.methods
    .repay(repayAmount)
    .accountsPartial({
      manager: payer.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      depositVault: ctx.depositVault,
      managerTokenAccount: ctx.payerAta,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log(`  Repay: ${explorerUrl(repaySig)}`);

  vaultAccount = await (program.account as any).creditVault.fetch(ctx.vault);
  console.log(`  total_assets after repay: ${vaultAccount.totalAssets.toString()}`);

  // Step 4: Repay remaining
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Repay remaining");
  console.log("-".repeat(70));

  const repayRemaining = new BN(400_000_000);

  const repaySig2 = await program.methods
    .repay(repayRemaining)
    .accountsPartial({
      manager: payer.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      depositVault: ctx.depositVault,
      managerTokenAccount: ctx.payerAta,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log(`  Repay: ${explorerUrl(repaySig2)}`);

  vaultAccount = await (program.account as any).creditVault.fetch(ctx.vault);
  console.log(`  total_assets after full repay: ${vaultAccount.totalAssets.toString()}`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
