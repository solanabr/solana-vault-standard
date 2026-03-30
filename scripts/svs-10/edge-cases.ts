/**
 * SVS-10 Edge Cases & Admin Operations
 *
 * Tests:
 * - Cancel deposit flow
 * - Cancel redeem flow
 * - Pause / unpause
 * - Transfer authority & transfer back
 *
 * Run: npx ts-node scripts/svs-10/edge-cases.ts
 */

import { BN } from "@coral-xyz/anchor";
import {
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  setupTest,
  createAndInitializeVault,
  depositCycle,
  explorerUrl,
  fundAccount,
  getDepositRequestAddress,
  getRedeemRequestAddress,
} from "./helpers";

async function main() {
  const setup = await setupTest("Edge Cases & Admin");
  const { connection, payer, program, programId } = setup;

  const results: { step: string; sig: string }[] = [];

  // Setup: initialize vault with a completed deposit so we have shares
  const ctx = await createAndInitializeVault(setup);

  const depositAmount = new BN(1_000_000_000);
  const dep = await depositCycle(setup, ctx, depositAmount);
  results.push({ step: "Setup deposit", sig: dep.claimSig });

  const sharesAccount = await getAccount(connection, ctx.userSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Shares for testing: ${sharesAccount.amount.toString()}`);

  // ── Cancel deposit flow ─────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Cancel deposit flow");
  console.log("-".repeat(70));

  const cancelDepAmount = new BN(500_000_000);
  const [depositRequest] = getDepositRequestAddress(programId, ctx.vault, payer.publicKey);

  const reqDepSig = await program.methods
    .requestDeposit(cancelDepAmount, payer.publicKey)
    .accounts({
      user: payer.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      userAssetAccount: ctx.userAta,
      assetVault: ctx.assetVault,
      depositRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Request deposit (cancel)", sig: reqDepSig });

  const cancelDepSig = await program.methods
    .cancelDeposit()
    .accounts({
      user: payer.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      userAssetAccount: ctx.userAta,
      assetVault: ctx.assetVault,
      depositRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  results.push({ step: "Cancel deposit", sig: cancelDepSig });
  console.log(`  OK: ${explorerUrl(cancelDepSig)}`);

  // ── Cancel redeem flow ──────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Cancel redeem flow");
  console.log("-".repeat(70));

  const cancelRedeemShares = new BN(100_000_000);
  const [redeemRequest] = getRedeemRequestAddress(programId, ctx.vault, payer.publicKey);

  const reqRedSig = await program.methods
    .requestRedeem(cancelRedeemShares, payer.publicKey)
    .accounts({
      user: payer.publicKey,
      vault: ctx.vault,
      sharesMint: ctx.sharesMint,
      userSharesAccount: ctx.userSharesAta,
      shareEscrow: ctx.shareEscrow,
      redeemRequest,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Request redeem (cancel)", sig: reqRedSig });

  const cancelRedSig = await program.methods
    .cancelRedeem()
    .accounts({
      user: payer.publicKey,
      vault: ctx.vault,
      sharesMint: ctx.sharesMint,
      userSharesAccount: ctx.userSharesAta,
      shareEscrow: ctx.shareEscrow,
      redeemRequest,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  results.push({ step: "Cancel redeem", sig: cancelRedSig });
  console.log(`  OK: ${explorerUrl(cancelRedSig)}`);

  // ── Pause / Unpause ─────────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Pause / Unpause");
  console.log("-".repeat(70));

  const pauseSig = await program.methods
    .pause()
    .accounts({ authority: payer.publicKey, vault: ctx.vault })
    .rpc();

  results.push({ step: "Pause vault", sig: pauseSig });
  console.log(`  Paused: ${explorerUrl(pauseSig)}`);

  const unpauseSig = await program.methods
    .unpause()
    .accounts({ authority: payer.publicKey, vault: ctx.vault })
    .rpc();

  results.push({ step: "Unpause vault", sig: unpauseSig });
  console.log(`  Unpaused: ${explorerUrl(unpauseSig)}`);

  // ── Transfer authority & transfer back ──────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("Transfer authority");
  console.log("-".repeat(70));

  const tempAuthority = Keypair.generate();

  const transferSig = await program.methods
    .transferAuthority(tempAuthority.publicKey)
    .accounts({ authority: payer.publicKey, vault: ctx.vault })
    .rpc();

  results.push({ step: "Transfer authority", sig: transferSig });
  console.log(`  Transferred to: ${tempAuthority.publicKey.toBase58()}`);
  console.log(`  OK: ${explorerUrl(transferSig)}`);

  await fundAccount(connection, payer, tempAuthority.publicKey, 0.01);

  const transferBackSig = await program.methods
    .transferAuthority(payer.publicKey)
    .accounts({ authority: tempAuthority.publicKey, vault: ctx.vault })
    .signers([tempAuthority])
    .rpc();

  results.push({ step: "Transfer authority back", sig: transferBackSig });
  console.log(`  Restored: ${explorerUrl(transferBackSig)}`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All edge case tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
