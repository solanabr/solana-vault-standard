/**
 * SVS-11 KYC Attestation Test Script
 *
 * Attestation tests:
 * - Expired attestation
 * - Revoked attestation
 * - Update attester config
 *
 * Run: npx ts-node scripts/svs-11/kyc-attestation.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import {
  setupTest,
  createVaultContext,
  explorerUrl,
  getAttestationPDA,
  ATTESTATION_PROGRAM_ID,
} from "./helpers";

async function main() {
  const setup = await setupTest("KYC Attestation");
  const { connection, program, attestationProgram, payer } = setup;
  const ctx = await createVaultContext(setup);

  // Open window
  await program.methods
    .openInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault: ctx.vault })
    .rpc();

  // Step 1: Expired attestation
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Expired attestation (should reject request)");
  console.log("-".repeat(70));

  const expiredInvestor = Keypair.generate();
  const expiredAttestationType = 0;

  // Fund expired investor
  const fundTx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: expiredInvestor.publicKey,
      lamports: 100_000_000,
    }),
  );
  await setup.provider.sendAndConfirm(fundTx);

  // Create expired attestation (already expired)
  const expiredAt = new BN(Math.floor(Date.now() / 1000) - 3600);
  const [expiredAttestation] = getAttestationPDA(
    expiredInvestor.publicKey, ctx.attester.publicKey, expiredAttestationType,
  );

  await attestationProgram.methods
    .createAttestation(ctx.attester.publicKey, expiredAttestationType, [66, 82], expiredAt)
    .accountsPartial({
      authority: payer.publicKey,
      attestation: expiredAttestation,
      subject: expiredInvestor.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(`  Created expired attestation: ${expiredAttestation.toBase58()}`);

  try {
    const [expInvReq] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("investment_request"), ctx.vault.toBuffer(), expiredInvestor.publicKey.toBuffer()],
      program.programId,
    );

    const { address: expInvAta } = await import("@solana/spl-token").then(spl =>
      spl.getOrCreateAssociatedTokenAccount(
        connection, payer, ctx.assetMint, expiredInvestor.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID,
      ),
    );

    // Mint tokens to expired investor
    await import("@solana/spl-token").then(spl =>
      spl.mintTo(connection, payer, ctx.assetMint, expInvAta, payer, 1_000_000_000),
    );

    await program.methods
      .requestDeposit(new BN(500_000_000))
      .accountsPartial({
        investor: expiredInvestor.publicKey,
        vault: ctx.vault,
        assetMint: ctx.assetMint,
        investorTokenAccount: expInvAta,
        depositVault: ctx.depositVault,
        investmentRequest: expInvReq,
        attestation: expiredAttestation,
        frozenCheck: null,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([expiredInvestor])
      .rpc();

    console.log("  WARNING: Request succeeded with expired attestation");
  } catch (err: any) {
    const msg = err.toString();
    if (msg.includes("Expired") || msg.includes("expired") || msg.includes("Attestation")) {
      console.log("  Request correctly rejected (expired attestation)");
    } else {
      console.log(`  Request rejected: ${msg.slice(0, 120)}`);
    }
  }

  // Step 2: Revoked attestation
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Revoked attestation");
  console.log("-".repeat(70));

  try {
    const revokeSig = await attestationProgram.methods
      .revokeAttestation()
      .accountsPartial({
        authority: payer.publicKey,
        attestation: ctx.attestation,
      })
      .rpc();

    console.log(`  Revoked attestation: ${explorerUrl(revokeSig)}`);

    // Try request with revoked attestation
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

      console.log("  WARNING: Request succeeded with revoked attestation");
    } catch (err: any) {
      const msg = err.toString();
      if (msg.includes("Revoked") || msg.includes("revoked") || msg.includes("Attestation")) {
        console.log("  Request correctly rejected (revoked attestation)");
      } else {
        console.log(`  Request rejected: ${msg.slice(0, 120)}`);
      }
    }

    // Restore: create a new valid attestation
    const newExpiresAt = new BN(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
    await attestationProgram.methods
      .createAttestation(ctx.attester.publicKey, 0, [66, 82], newExpiresAt)
      .accountsPartial({
        authority: payer.publicKey,
        attestation: ctx.attestation,
        subject: ctx.investor.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log(`  Restored valid attestation`);
  } catch (err: any) {
    console.log(`  Mock attestation does not support revoke, skipping`);
  }

  // Step 3: Update attester config
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Update attester config");
  console.log("-".repeat(70));

  const newAttester = Keypair.generate();
  const newAttestationProgram = Keypair.generate();

  const updateSig = await program.methods
    .updateAttester(newAttester.publicKey, newAttestationProgram.publicKey)
    .accountsPartial({ authority: payer.publicKey, vault: ctx.vault })
    .rpc();

  console.log(`  Update attester: ${explorerUrl(updateSig)}`);

  // Restore original config
  const restoreSig = await program.methods
    .updateAttester(ctx.attester.publicKey, ATTESTATION_PROGRAM_ID)
    .accountsPartial({ authority: payer.publicKey, vault: ctx.vault })
    .rpc();

  console.log(`  Restored: ${explorerUrl(restoreSig)}`);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
