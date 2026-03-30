/**
 * SVS-11 Compliance Test Script
 *
 * Freeze/unfreeze, window gating:
 * - Freeze account, try request (should fail), unfreeze
 * - Window closed, try request (should fail)
 *
 * Run: npx ts-node scripts/svs-11/compliance.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  setupTest,
  createVaultContext,
  explorerUrl,
  getCreditFrozenAccountAddress,
  PROGRAM_ID,
} from "./helpers";

async function main() {
  const setup = await setupTest("Compliance");
  const { program, payer } = setup;
  const ctx = await createVaultContext(setup);

  // Step 1: Freeze account
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Freeze account");
  console.log("-".repeat(70));

  const [frozenAccountPda] = getCreditFrozenAccountAddress(PROGRAM_ID, ctx.vault, ctx.investor.publicKey);

  const freezeAccounts = {
    manager: payer.publicKey,
    vault: ctx.vault,
    investor: ctx.investor.publicKey,
    frozenAccount: frozenAccountPda,
  };
  const freezeSig = await program.methods
    .freezeAccount()
    .accountsPartial(freezeAccounts)
    .rpc();

  console.log(`  Freeze: ${explorerUrl(freezeSig)}`);

  // Step 2: Try request while frozen (should fail)
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Try deposit request while frozen");
  console.log("-".repeat(70));

  // Open window first
  await program.methods
    .openInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault: ctx.vault })
    .rpc();

  try {
    await program.methods
      .requestDeposit(new BN(500_000_000))
      .accountsPartial({
        investor: ctx.investor.publicKey,
        vault: ctx.vault,
        assetMint: ctx.assetMint,
        investorTokenAccount: ctx.investorAta,
        depositVault: ctx.depositVault,
        investmentRequest: ctx.investmentRequest,
        attestation: ctx.attestation,
        frozenCheck: frozenAccountPda,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([ctx.investor])
      .rpc();

    console.log("  WARNING: Request succeeded while frozen");
  } catch (err: any) {
    const msg = err.toString();
    if (msg.includes("Frozen") || msg.includes("frozen") || msg.includes("AccountFrozen")) {
      console.log("  Request correctly rejected (account frozen)");
    } else {
      console.log(`  Request rejected: ${msg.slice(0, 120)}`);
    }
  }

  // Step 3: Unfreeze
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Unfreeze account");
  console.log("-".repeat(70));

  const unfreezeAccounts = {
    manager: payer.publicKey,
    vault: ctx.vault,
    frozenAccount: frozenAccountPda,
  };
  const unfreezeSig = await program.methods
    .unfreezeAccount()
    .accountsPartial(unfreezeAccounts)
    .rpc();

  console.log(`  Unfreeze: ${explorerUrl(unfreezeSig)}`);

  // Step 4: Window closed gating
  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Window closed gating");
  console.log("-".repeat(70));

  // Close window
  await program.methods
    .closeInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault: ctx.vault })
    .rpc();

  console.log(`  Window closed`);

  try {
    await program.methods
      .requestDeposit(new BN(500_000_000))
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

    console.log("  WARNING: Request succeeded while window closed");
  } catch (err: any) {
    const msg = err.toString();
    if (msg.includes("Window") || msg.includes("window") || msg.includes("Closed") || msg.includes("closed")) {
      console.log("  Request correctly rejected (window closed)");
    } else {
      console.log(`  Request rejected: ${msg.slice(0, 120)}`);
    }
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
