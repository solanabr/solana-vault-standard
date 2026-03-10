/**
 * SVS-10 Async Vault — End-to-End Devnet Lifecycle Script
 *
 * Exercises every SVS-10 instruction on devnet:
 *   1.  Create asset mint & fund wallet
 *   2.  Initialize async vault
 *   3.  Request deposit → fulfill → claim shares
 *   4.  Request redeem → fulfill → claim assets
 *   5.  Cancel deposit flow
 *   6.  Cancel redeem flow
 *   7.  Set operator (granular permissions)
 *   8.  Transfer authority & transfer back
 *   9.  Set vault operator
 *   10. Pause / unpause
 *   11. View functions (pending/claimable queries)
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-node scripts/e2e-svs10-devnet.ts
 *
 * Requires:
 *   - Wallet with devnet SOL (2+ SOL recommended)
 *   - `anchor build -p svs_10` completed (IDL must exist)
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
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("CpjFjyxRwTGYxR6JWXpfQ1923z5wVwpyBvgPFjm9jamJ");

function explorerLink(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function accountLink(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

// PDA helpers
function getVaultPDA(assetMint: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  );
}

function getSharesMintPDA(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("shares"), vault.toBuffer()], PROGRAM_ID);
}

function getShareEscrowPDA(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("share_escrow"), vault.toBuffer()], PROGRAM_ID);
}

function getDepositRequestPDA(vault: PublicKey, user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deposit_request"), vault.toBuffer(), user.toBuffer()],
    PROGRAM_ID,
  );
}

function getRedeemRequestPDA(vault: PublicKey, user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redeem_request"), vault.toBuffer(), user.toBuffer()],
    PROGRAM_ID,
  );
}

function getClaimableTokensPDA(vault: PublicKey, user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claimable_tokens"), vault.toBuffer(), user.toBuffer()],
    PROGRAM_ID,
  );
}

function getOperatorApprovalPDA(vault: PublicKey, owner: PublicKey, operator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("operator_approval"), vault.toBuffer(), owner.toBuffer(), operator.toBuffer()],
    PROGRAM_ID,
  );
}

async function main() {
  console.log("=".repeat(70));
  console.log("  SVS-10 Async Vault — E2E Devnet Lifecycle");
  console.log("=".repeat(70));
  console.log();

  // Setup provider from env vars
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load IDL from file
  const idlPath = path.resolve(__dirname, "../target/idl/svs_10.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider);

  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  console.log(`Program ID:  ${PROGRAM_ID.toBase58()}`);
  console.log(`Payer:       ${payer.publicKey.toBase58()}`);
  console.log(`RPC:         ${connection.rpcEndpoint}`);

  // Use a unique vault ID to avoid PDA collisions with previous runs
  const vaultId = new BN(Date.now() % 100000);
  console.log(`Vault ID:    ${vaultId.toString()}`);
  console.log();

  const results: { step: string; sig: string }[] = [];

  // ─────────────────────────────────────────────────────────────────────
  // Step 1: Create asset mint and fund accounts
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 1: Creating asset mint and funding accounts...");

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, 6,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );
  console.log(`  Asset mint: ${assetMint.toBase58()}`);

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );

  const mintAmount = 10_000_000_000; // 10,000 with 6 decimals
  await mintTo(connection, payer, assetMint, userAta.address, payer, mintAmount);
  console.log(`  Minted: ${mintAmount / 1_000_000} tokens`);

  // Derive PDAs
  const [vault] = getVaultPDA(assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(vault);
  const [shareEscrow] = getShareEscrowPDA(vault);
  const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);
  console.log(`  Vault PDA:  ${vault.toBase58()}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 2: Initialize vault
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 2: Initializing async vault...");

  const initSig = await program.methods
    .initialize(vaultId, "SVS-10 E2E Test", "SVS10", "")
    .accounts({
      authority: payer.publicKey,
      operator: payer.publicKey, // payer acts as operator for E2E
      vault,
      assetMint,
      sharesMint,
      assetVault,
      shareEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  results.push({ step: "Initialize vault", sig: initSig });
  console.log(`  OK: ${explorerLink(initSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 3: Request deposit (1,000 tokens)
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 3: Requesting deposit (1,000 tokens)...");

  const depositAmount = new BN(1_000_000_000);
  const [depositRequest] = getDepositRequestPDA(vault, payer.publicKey);

  const reqDepSig = await program.methods
    .requestDeposit(depositAmount, payer.publicKey)
    .accounts({
      user: payer.publicKey,
      vault,
      assetMint,
      userAssetAccount: userAta.address,
      assetVault,
      depositRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Request deposit", sig: reqDepSig });
  console.log(`  OK: ${explorerLink(reqDepSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 4: Fulfill deposit (vault-priced)
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 4: Fulfilling deposit (vault-priced)...");

  const fulDepSig = await program.methods
    .fulfillDeposit(null)
    .accounts({
      operator: payer.publicKey,
      vault,
      assetMint,
      sharesMint,
      depositRequest,
      assetVault,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  results.push({ step: "Fulfill deposit", sig: fulDepSig });
  console.log(`  OK: ${explorerLink(fulDepSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 5: Claim deposit (receive shares)
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 5: Claiming deposit shares...");

  const userSharesAta = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );

  const claimDepSig = await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: payer.publicKey,
      vault,
      depositRequest,
      owner: payer.publicKey,
      sharesMint,
      receiverSharesAccount: userSharesAta,
      receiver: payer.publicKey,
      operatorApproval: PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Claim deposit", sig: claimDepSig });
  const sharesAccount = await getAccount(connection, userSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Shares received: ${sharesAccount.amount.toString()}`);
  console.log(`  OK: ${explorerLink(claimDepSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 6: Request redeem (half of shares)
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 6: Requesting redeem (half of shares)...");

  const redeemShares = new BN(sharesAccount.amount.toString()).div(new BN(2));
  const [redeemRequest] = getRedeemRequestPDA(vault, payer.publicKey);

  const reqRedSig = await program.methods
    .requestRedeem(redeemShares, payer.publicKey)
    .accounts({
      user: payer.publicKey,
      vault,
      sharesMint,
      userSharesAccount: userSharesAta,
      shareEscrow,
      redeemRequest,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Request redeem", sig: reqRedSig });
  console.log(`  Shares locked: ${redeemShares.toString()}`);
  console.log(`  OK: ${explorerLink(reqRedSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 7: Fulfill redeem
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 7: Fulfilling redeem...");

  const [claimableTokens] = getClaimableTokensPDA(vault, payer.publicKey);

  const fulRedSig = await program.methods
    .fulfillRedeem(null)
    .accounts({
      operator: payer.publicKey,
      vault,
      assetMint,
      sharesMint,
      shareEscrow,
      redeemRequest,
      assetVault,
      claimableTokens,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Fulfill redeem", sig: fulRedSig });
  console.log(`  OK: ${explorerLink(fulRedSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 8: Claim redeem (receive assets)
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 8: Claiming redeemed assets...");

  const claimRedSig = await program.methods
    .claimRedeem()
    .accountsStrict({
      claimant: payer.publicKey,
      vault,
      assetMint,
      redeemRequest,
      owner: payer.publicKey,
      claimableTokens,
      receiverAssetAccount: userAta.address,
      receiver: payer.publicKey,
      operatorApproval: PROGRAM_ID,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Claim redeem", sig: claimRedSig });
  console.log(`  OK: ${explorerLink(claimRedSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 9: Cancel deposit flow
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 9: Testing cancel deposit flow...");

  const cancelAmount = new BN(500_000_000);
  const [depositRequest2] = getDepositRequestPDA(vault, payer.publicKey);

  const reqDep2Sig = await program.methods
    .requestDeposit(cancelAmount, payer.publicKey)
    .accounts({
      user: payer.publicKey,
      vault,
      assetMint,
      userAssetAccount: userAta.address,
      assetVault,
      depositRequest: depositRequest2,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Request deposit (cancel test)", sig: reqDep2Sig });

  const cancelSig = await program.methods
    .cancelDeposit()
    .accounts({
      user: payer.publicKey,
      vault,
      assetMint,
      userAssetAccount: userAta.address,
      assetVault,
      depositRequest: depositRequest2,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Cancel deposit", sig: cancelSig });
  console.log(`  OK: ${explorerLink(cancelSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 10: Cancel redeem flow
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 10: Testing cancel redeem flow...");

  // First request a new redeem so we can cancel it
  const cancelRedeemShares = new BN(100_000_000); // small amount
  const [redeemRequest2] = getRedeemRequestPDA(vault, payer.publicKey);

  const reqRed2Sig = await program.methods
    .requestRedeem(cancelRedeemShares, payer.publicKey)
    .accounts({
      user: payer.publicKey,
      vault,
      sharesMint,
      userSharesAccount: userSharesAta,
      shareEscrow,
      redeemRequest: redeemRequest2,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Request redeem (cancel test)", sig: reqRed2Sig });

  const cancelRedSig = await program.methods
    .cancelRedeem()
    .accounts({
      user: payer.publicKey,
      vault,
      sharesMint,
      userSharesAccount: userSharesAta,
      shareEscrow,
      redeemRequest: redeemRequest2,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Cancel redeem", sig: cancelRedSig });
  console.log(`  OK: ${explorerLink(cancelRedSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 11: Set operator (granular permissions)
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 11: Setting operator with granular permissions...");

  const operatorKp = Keypair.generate();
  const [operatorApproval] = getOperatorApprovalPDA(vault, payer.publicKey, operatorKp.publicKey);

  const setOpSig = await program.methods
    .setOperator(operatorKp.publicKey, true, true, true)
    .accounts({
      owner: payer.publicKey,
      vault,
      operatorApproval,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Set operator (approve all)", sig: setOpSig });
  console.log(`  Operator: ${operatorKp.publicKey.toBase58()}`);
  console.log(`  OK: ${explorerLink(setOpSig)}`);

  // Revoke operator
  const revokeOpSig = await program.methods
    .setOperator(operatorKp.publicKey, false, false, false)
    .accounts({
      owner: payer.publicKey,
      vault,
      operatorApproval,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Set operator (revoke)", sig: revokeOpSig });
  console.log(`  Revoked: ${explorerLink(revokeOpSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 12: Set vault operator (admin)
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 12: Setting vault operator...");

  const newOperatorKp = Keypair.generate();
  const setVaultOpSig = await program.methods
    .setVaultOperator(newOperatorKp.publicKey)
    .accounts({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Set vault operator", sig: setVaultOpSig });
  console.log(`  New operator: ${newOperatorKp.publicKey.toBase58()}`);
  console.log(`  OK: ${explorerLink(setVaultOpSig)}`);

  // Restore original operator so remaining steps work
  const restoreOpSig = await program.methods
    .setVaultOperator(payer.publicKey)
    .accounts({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Restore vault operator", sig: restoreOpSig });
  console.log(`  Restored: ${explorerLink(restoreOpSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 13: Transfer authority & transfer back
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 13: Testing transfer authority...");

  const tempAuthority = Keypair.generate();
  const transferAuthSig = await program.methods
    .transferAuthority(tempAuthority.publicKey)
    .accounts({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Transfer authority", sig: transferAuthSig });
  console.log(`  Transferred to: ${tempAuthority.publicKey.toBase58()}`);
  console.log(`  OK: ${explorerLink(transferAuthSig)}`);

  // Transfer back (need to fund temp authority for tx fee)
  const fundTx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tempAuthority.publicKey,
      lamports: 10_000_000, // 0.01 SOL for tx fee
    }),
  );
  await provider.sendAndConfirm(fundTx);

  const transferBackSig = await program.methods
    .transferAuthority(payer.publicKey)
    .accounts({ authority: tempAuthority.publicKey, vault })
    .signers([tempAuthority])
    .rpc();

  results.push({ step: "Transfer authority back", sig: transferBackSig });
  console.log(`  Restored: ${explorerLink(transferBackSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 14: Pause / Unpause
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 14: Testing pause/unpause...");

  const pauseSig = await program.methods
    .pause()
    .accounts({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Pause vault", sig: pauseSig });

  const unpauseSig = await program.methods
    .unpause()
    .accounts({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Unpause vault", sig: unpauseSig });
  console.log(`  OK: ${explorerLink(unpauseSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 15: View functions
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 15: Testing view functions...");

  // Create a deposit request to query
  const viewDepAmount = new BN(200_000_000);
  const [viewDepRequest] = getDepositRequestPDA(vault, payer.publicKey);

  const viewReqSig = await program.methods
    .requestDeposit(viewDepAmount, payer.publicKey)
    .accounts({
      user: payer.publicKey,
      vault,
      assetMint,
      userAssetAccount: userAta.address,
      assetVault,
      depositRequest: viewDepRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Request deposit (view test)", sig: viewReqSig });

  // Query pending deposit via simulate
  const pendingDepSig = await program.methods
    .pendingDepositRequest()
    .accounts({ vault })
    .remainingAccounts([{ pubkey: viewDepRequest, isWritable: false, isSigner: false }])
    .simulate();

  console.log(`  pendingDepositRequest: simulated OK (return data present: ${!!pendingDepSig.raw})`);

  // Clean up: cancel the view test deposit
  const viewCancelSig = await program.methods
    .cancelDeposit()
    .accounts({
      user: payer.publicKey,
      vault,
      assetMint,
      userAssetAccount: userAta.address,
      assetVault,
      depositRequest: viewDepRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "View + cancel cleanup", sig: viewCancelSig });
  console.log(`  OK: ${explorerLink(viewCancelSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────
  console.log("=".repeat(70));
  console.log("  E2E RESULTS SUMMARY");
  console.log("=".repeat(70));
  console.log();
  console.log(`Program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`Vault:    ${vault.toBase58()}`);
  console.log(`Explorer: ${accountLink(vault.toBase58())}`);
  console.log();

  for (const r of results) {
    console.log(`  ${r.step.padEnd(30)} ${explorerLink(r.sig)}`);
  }

  console.log();
  console.log(`All ${results.length} steps completed successfully!`);
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
