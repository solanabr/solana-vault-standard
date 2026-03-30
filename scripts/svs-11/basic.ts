/**
 * SVS-11 Basic Test Script
 *
 * Happy-path lifecycle:
 * - Create mint, set oracle, create attestation, initialize vault
 * - Open window -> request deposit -> approve -> claim
 * - Close window -> open -> request redeem -> approve -> claim
 *
 * Run: npx ts-node scripts/svs-11/basic.ts
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
  accountUrl,
} from "./helpers";

async function main() {
  const setup = await setupTest("Basic Lifecycle");
  const { program, payer } = setup;

  // Step 1: Create vault (mint, oracle, attestation, init)
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Creating vault with all dependencies");
  console.log("-".repeat(70));

  const ctx = await createVaultContext(setup);
  console.log(`  Explorer: ${accountUrl(ctx.vault.toBase58())}`);

  // Step 2: Open investment window
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Opening investment window");
  console.log("-".repeat(70));

  const openSig = await program.methods
    .openInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault: ctx.vault })
    .rpc();

  console.log(`  Tx: ${openSig}`);
  console.log(`  Explorer: ${explorerUrl(openSig)}`);

  // Step 3: Deposit flow
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Deposit flow (request -> approve -> claim)");
  console.log("-".repeat(70));

  const depositAmount = new BN(1_000_000_000);

  const reqDepSig = await program.methods
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

  console.log(`  Request deposit: ${explorerUrl(reqDepSig)}`);

  const appDepSig = await program.methods
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

  console.log(`  Approve deposit: ${explorerUrl(appDepSig)}`);

  const claimDepSig = await program.methods
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

  const sharesAccount = await getAccount(setup.connection, ctx.investorSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Shares received: ${sharesAccount.amount.toString()}`);
  console.log(`  Claim deposit: ${explorerUrl(claimDepSig)}`);

  // Step 4: Close investment window
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Closing investment window");
  console.log("-".repeat(70));

  const closeSig = await program.methods
    .closeInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault: ctx.vault })
    .rpc();

  console.log(`  Tx: ${closeSig}`);
  console.log(`  Explorer: ${explorerUrl(closeSig)}`);

  // Step 5: Redeem flow
  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Redeem flow (open -> request -> approve -> claim)");
  console.log("-".repeat(70));

  await program.methods
    .openInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault: ctx.vault })
    .rpc();

  const redeemShares = new BN(sharesAccount.amount.toString()).div(new BN(2));

  const reqRedSig = await program.methods
    .requestRedeem(redeemShares)
    .accountsPartial({
      investor: ctx.investor.publicKey,
      vault: ctx.vault,
      sharesMint: ctx.sharesMint,
      investorSharesAccount: ctx.investorSharesAta,
      redemptionEscrow: ctx.redemptionEscrow,
      redemptionRequest: ctx.redemptionRequest,
      attestation: ctx.attestation,
      frozenCheck: null,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([ctx.investor])
    .rpc();

  console.log(`  Request redeem: ${explorerUrl(reqRedSig)}`);

  const appRedSig = await program.methods
    .approveRedeem()
    .accountsPartial({
      manager: payer.publicKey,
      vault: ctx.vault,
      redemptionRequest: ctx.redemptionRequest,
      investor: ctx.investor.publicKey,
      assetMint: ctx.assetMint,
      depositVault: ctx.depositVault,
      sharesMint: ctx.sharesMint,
      redemptionEscrow: ctx.redemptionEscrow,
      claimableTokens: ctx.claimableTokens,
      navOracle: ctx.navOracle,
      attestation: ctx.attestation,
      frozenCheck: null,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(`  Approve redeem: ${explorerUrl(appRedSig)}`);

  const claimRedSig = await program.methods
    .claimRedeem()
    .accountsPartial({
      investor: ctx.investor.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      redemptionRequest: ctx.redemptionRequest,
      claimableTokens: ctx.claimableTokens,
      investorTokenAccount: ctx.investorAta,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([ctx.investor])
    .rpc();

  console.log(`  Claim redeem: ${explorerUrl(claimRedSig)}`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
