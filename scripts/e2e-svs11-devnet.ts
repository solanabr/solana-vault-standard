/**
 * SVS-11 Credit Markets Vault — End-to-End Devnet Lifecycle Script
 *
 * Exercises every SVS-11 instruction on devnet:
 *   1.  Create asset mint & fund wallet
 *   2.  Set oracle price (mock oracle)
 *   3.  Create SAS attestation (mock SAS)
 *   4.  Initialize credit vault
 *   5.  Open investment window
 *   6.  Request deposit → approve → claim shares
 *   7.  Close investment window
 *   8.  Request redeem → approve → claim assets
 *   9.  Cancel deposit / cancel redeem flows
 *   10. Draw down / repay (credit ops)
 *   11. Freeze / unfreeze (compliance)
 *   12. Pause / unpause
 *   13. Set manager / transfer authority
 *   14. Update SAS config
 *   15. Reject deposit
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-node scripts/e2e-svs11-devnet.ts
 *
 * Requires:
 *   - Wallet with devnet SOL (2+ SOL recommended)
 *   - `anchor build` completed (IDLs must exist for svs_11, mock_oracle, mock_sas)
 *   - mock_oracle and mock_sas deployed on devnet
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

const PROGRAM_ID = new PublicKey("Bf17gDR2JdKTWdoTWK3Va9YQtkpePRAAVxMCaokj8ZFW");
const MOCK_ORACLE_ID = new PublicKey("EbFcZZApkGcX6LqRmzSWVLasnDM457wY4WvhJRnVjdZF");
const SAS_PROGRAM_ID = new PublicKey("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
const PRICE_SCALE = new BN(1_000_000_000);

function explorerLink(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function accountLink(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

// PDA helpers — SVS-11
function getVaultPDA(assetMint: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("credit_vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  );
}

function getSharesMintPDA(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("shares"), vault.toBuffer()], PROGRAM_ID);
}

function getRedemptionEscrowPDA(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("redemption_escrow"), vault.toBuffer()], PROGRAM_ID);
}

function getInvestmentRequestPDA(vault: PublicKey, investor: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("investment_request"), vault.toBuffer(), investor.toBuffer()],
    PROGRAM_ID,
  );
}

function getRedemptionRequestPDA(vault: PublicKey, investor: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redemption_request"), vault.toBuffer(), investor.toBuffer()],
    PROGRAM_ID,
  );
}

function getClaimableTokensPDA(vault: PublicKey, investor: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claimable_tokens"), vault.toBuffer(), investor.toBuffer()],
    PROGRAM_ID,
  );
}

function getFrozenAccountPDA(vault: PublicKey, investor: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("frozen_account"), vault.toBuffer(), investor.toBuffer()],
    PROGRAM_ID,
  );
}

// PDA helpers — Mock Oracle
function getOracleDataPDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), authority.toBuffer()],
    MOCK_ORACLE_ID,
  );
}

// PDA helpers — Mock SAS
function getAttestationPDA(credential: PublicKey, schema: PublicKey, investor: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [credential.toBuffer(), schema.toBuffer(), investor.toBuffer()],
    SAS_PROGRAM_ID,
  );
}

async function main() {
  console.log("=".repeat(70));
  console.log("  SVS-11 Credit Markets Vault — E2E Devnet Lifecycle");
  console.log("=".repeat(70));
  console.log();

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const svs11Idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/svs_11.json"), "utf-8"));
  const oracleIdl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/mock_oracle.json"), "utf-8"));
  const sasIdl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/mock_sas.json"), "utf-8"));

  const program = new Program(svs11Idl, provider);
  const oracleProgram = new Program(oracleIdl, provider);
  const sasProgram = new Program(sasIdl, provider);

  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  console.log(`Program ID:     ${PROGRAM_ID.toBase58()}`);
  console.log(`Mock Oracle:    ${MOCK_ORACLE_ID.toBase58()}`);
  console.log(`SAS Program:    ${SAS_PROGRAM_ID.toBase58()}`);
  console.log(`Payer:          ${payer.publicKey.toBase58()}`);
  console.log(`RPC:            ${connection.rpcEndpoint}`);

  const vaultId = new BN(Date.now() % 100000);
  console.log(`Vault ID:       ${vaultId.toString()}`);
  console.log();

  const results: { step: string; sig: string }[] = [];

  const sasCredential = Keypair.generate();
  const sasSchema = Keypair.generate();
  const investor = Keypair.generate();

  // ─────────────────────────────────────────────────────────────────────
  // Step 1: Create asset mint and fund accounts
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 1: Creating asset mint and funding accounts...");

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, 6,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );
  console.log(`  Asset mint: ${assetMint.toBase58()}`);

  const payerAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );

  // Fund investor with SOL for tx fees
  const fundTx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: investor.publicKey,
      lamports: 100_000_000,
    }),
  );
  await provider.sendAndConfirm(fundTx);

  const investorAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, investor.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );

  const mintAmount = 10_000_000_000; // 10,000 tokens (6 decimals)
  await mintTo(connection, payer, assetMint, investorAta.address, payer, mintAmount);
  await mintTo(connection, payer, assetMint, payerAta.address, payer, mintAmount);
  console.log(`  Minted: ${mintAmount / 1_000_000} tokens to investor + manager`);

  // Derive PDAs
  const [vault] = getVaultPDA(assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(vault);
  const [redemptionEscrow] = getRedemptionEscrowPDA(vault);
  const depositVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);
  const [investmentRequest] = getInvestmentRequestPDA(vault, investor.publicKey);
  const [redemptionRequest] = getRedemptionRequestPDA(vault, investor.publicKey);
  const [claimableTokens] = getClaimableTokensPDA(vault, investor.publicKey);
  const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);
  const [navOracle] = getOracleDataPDA(payer.publicKey);

  console.log(`  Vault PDA:  ${vault.toBase58()}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 2: Set oracle price
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 2: Setting oracle price (1:1)...");

  const oracleSig = await oracleProgram.methods
    .setPrice(PRICE_SCALE)
    .accountsPartial({
      authority: payer.publicKey,
      oracleData: navOracle,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Set oracle price", sig: oracleSig });
  console.log(`  Oracle: ${navOracle.toBase58()}`);
  console.log(`  OK: ${explorerLink(oracleSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 3: Create SAS attestation for investor
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 3: Creating SAS attestation for investor...");

  const [attestation] = getAttestationPDA(sasCredential.publicKey, sasSchema.publicKey, investor.publicKey);

  const sasSig = await sasProgram.methods
    .createAttestation(sasCredential.publicKey, sasSchema.publicKey, new BN(0))
    .accountsPartial({
      authority: payer.publicKey,
      attestation,
      investor: investor.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Create SAS attestation", sig: sasSig });
  console.log(`  Attestation: ${attestation.toBase58()}`);
  console.log(`  OK: ${explorerLink(sasSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 4: Initialize credit vault
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 4: Initializing credit vault...");

  const initSig = await program.methods
    .initializePool(
      vaultId,
      "Credit Vault E2E",
      "CRED",
      "",
      new BN(1_000_000), // 1 token minimum
      new BN(3600),
    )
    .accountsPartial({
      authority: payer.publicKey,
      manager: payer.publicKey,
      assetMint,
      navOracle,
      oracleProgram: MOCK_ORACLE_ID,
      sasCredential: sasCredential.publicKey,
      sasSchema: sasSchema.publicKey,
      vault,
      sharesMint,
      depositVault,
      redemptionEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  results.push({ step: "Initialize vault", sig: initSig });
  console.log(`  OK: ${explorerLink(initSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 5: Open investment window
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 5: Opening investment window...");

  const openSig = await program.methods
    .openInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Open investment window", sig: openSig });
  console.log(`  OK: ${explorerLink(openSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 6: Deposit flow — request → approve → claim
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 6: Deposit flow...");

  const depositAmount = new BN(1_000_000_000); // 1,000 tokens

  const reqDepSig = await program.methods
    .requestDeposit(depositAmount)
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      assetMint,
      investorTokenAccount: investorAta.address,
      depositVault,
      investmentRequest,
      attestation,
      frozenAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Request deposit", sig: reqDepSig });
  console.log(`  Request deposit: ${explorerLink(reqDepSig)}`);

  const appDepSig = await program.methods
    .approveDeposit()
    .accountsPartial({
      manager: payer.publicKey,
      vault,
      investmentRequest,
      navOracle,
      oracleProgram: MOCK_ORACLE_ID,
    })
    .rpc();

  results.push({ step: "Approve deposit", sig: appDepSig });
  console.log(`  Approve deposit: ${explorerLink(appDepSig)}`);

  const investorSharesAta = getAssociatedTokenAddressSync(
    sharesMint, investor.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );

  const claimDepSig = await program.methods
    .claimDeposit()
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      investmentRequest,
      sharesMint,
      investorSharesAccount: investorSharesAta,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Claim deposit", sig: claimDepSig });
  const sharesAccount = await getAccount(connection, investorSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`  Shares received: ${sharesAccount.amount.toString()}`);
  console.log(`  Claim deposit: ${explorerLink(claimDepSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 7: Close investment window
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 7: Closing investment window...");

  const closeSig = await program.methods
    .closeInvestmentWindow()
    .accountsPartial({ manager: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Close investment window", sig: closeSig });
  console.log(`  OK: ${explorerLink(closeSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 8: Redeem flow — request → approve → claim
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 8: Redeem flow...");

  const redeemShares = new BN(sharesAccount.amount.toString()).div(new BN(2));

  const reqRedSig = await program.methods
    .requestRedeem(redeemShares)
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      sharesMint,
      investorSharesAccount: investorSharesAta,
      redemptionEscrow,
      redemptionRequest,
      attestation,
      frozenAccount,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Request redeem", sig: reqRedSig });
  console.log(`  Request redeem: ${explorerLink(reqRedSig)}`);

  const appRedSig = await program.methods
    .approveRedeem()
    .accountsPartial({
      manager: payer.publicKey,
      vault,
      redemptionRequest,
      assetMint,
      depositVault,
      sharesMint,
      redemptionEscrow,
      claimableTokens,
      navOracle,
      oracleProgram: MOCK_ORACLE_ID,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Approve redeem", sig: appRedSig });
  console.log(`  Approve redeem: ${explorerLink(appRedSig)}`);

  const claimRedSig = await program.methods
    .claimRedeem()
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      assetMint,
      redemptionRequest,
      claimableTokens,
      investorTokenAccount: investorAta.address,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Claim redeem", sig: claimRedSig });
  console.log(`  Claim redeem: ${explorerLink(claimRedSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 9: Cancel deposit flow
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 9: Cancel deposit flow...");

  // Re-open window for cancel test
  await program.methods.openInvestmentWindow().accountsPartial({ manager: payer.publicKey, vault }).rpc();

  const cancelDepAmount = new BN(500_000_000);
  const reqDep2Sig = await program.methods
    .requestDeposit(cancelDepAmount)
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      assetMint,
      investorTokenAccount: investorAta.address,
      depositVault,
      investmentRequest,
      attestation,
      frozenAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Request deposit (cancel test)", sig: reqDep2Sig });

  const cancelDepSig = await program.methods
    .cancelDeposit()
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      assetMint,
      investmentRequest,
      investorTokenAccount: investorAta.address,
      depositVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Cancel deposit", sig: cancelDepSig });
  console.log(`  OK: ${explorerLink(cancelDepSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 10: Cancel redeem flow
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 10: Cancel redeem flow...");

  const cancelRedeemShares = new BN(100_000_000_000); // small amount
  const reqRed2Sig = await program.methods
    .requestRedeem(cancelRedeemShares)
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      sharesMint,
      investorSharesAccount: investorSharesAta,
      redemptionEscrow,
      redemptionRequest,
      attestation,
      frozenAccount,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Request redeem (cancel test)", sig: reqRed2Sig });

  const cancelRedSig = await program.methods
    .cancelRedeem()
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      sharesMint,
      investorSharesAccount: investorSharesAta,
      redemptionEscrow,
      redemptionRequest,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Cancel redeem", sig: cancelRedSig });
  console.log(`  OK: ${explorerLink(cancelRedSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 11: Draw down / repay (credit ops)
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 11: Credit operations (draw_down + repay)...");

  const managerAta = payerAta; // manager is payer
  const drawAmount = new BN(200_000_000);

  const drawSig = await program.methods
    .drawDown(drawAmount)
    .accountsPartial({
      manager: payer.publicKey,
      vault,
      assetMint,
      depositVault,
      managerTokenAccount: managerAta.address,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  results.push({ step: "Draw down", sig: drawSig });
  console.log(`  Draw down: ${explorerLink(drawSig)}`);

  const repaySig = await program.methods
    .repay(drawAmount)
    .accountsPartial({
      manager: payer.publicKey,
      vault,
      assetMint,
      depositVault,
      managerTokenAccount: managerAta.address,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  results.push({ step: "Repay", sig: repaySig });
  console.log(`  Repay: ${explorerLink(repaySig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 12: Freeze / unfreeze (compliance)
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 12: Compliance (freeze + unfreeze)...");

  const freezeSig = await program.methods
    .freezeAccount()
    .accountsPartial({
      authority: payer.publicKey,
      vault,
      investor: investor.publicKey,
      frozenAccount,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Freeze account", sig: freezeSig });
  console.log(`  Freeze: ${explorerLink(freezeSig)}`);

  const unfreezeSig = await program.methods
    .unfreezeAccount()
    .accountsPartial({
      authority: payer.publicKey,
      vault,
      investor: investor.publicKey,
      frozenAccount,
    })
    .rpc();

  results.push({ step: "Unfreeze account", sig: unfreezeSig });
  console.log(`  Unfreeze: ${explorerLink(unfreezeSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 13: Pause / unpause
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 13: Pause / unpause...");

  const pauseSig = await program.methods
    .pause()
    .accountsPartial({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Pause vault", sig: pauseSig });

  const unpauseSig = await program.methods
    .unpause()
    .accountsPartial({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Unpause vault", sig: unpauseSig });
  console.log(`  OK: ${explorerLink(unpauseSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 14: Set manager / transfer authority
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 14: Admin operations...");

  const tempManager = Keypair.generate();
  const setMgrSig = await program.methods
    .setManager(tempManager.publicKey)
    .accountsPartial({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Set manager", sig: setMgrSig });
  console.log(`  Set manager: ${explorerLink(setMgrSig)}`);

  // Restore original manager
  const restoreMgrSig = await program.methods
    .setManager(payer.publicKey)
    .accountsPartial({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Restore manager", sig: restoreMgrSig });

  const tempAuthority = Keypair.generate();
  const xferAuthSig = await program.methods
    .transferAuthority(tempAuthority.publicKey)
    .accountsPartial({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Transfer authority", sig: xferAuthSig });
  console.log(`  Transfer authority: ${explorerLink(xferAuthSig)}`);

  // Fund temp authority and transfer back
  const fundAuth = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tempAuthority.publicKey,
      lamports: 10_000_000,
    }),
  );
  await provider.sendAndConfirm(fundAuth);

  const xferBackSig = await program.methods
    .transferAuthority(payer.publicKey)
    .accountsPartial({ authority: tempAuthority.publicKey, vault })
    .signers([tempAuthority])
    .rpc();

  results.push({ step: "Transfer authority back", sig: xferBackSig });
  console.log(`  Restored: ${explorerLink(xferBackSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 15: Update SAS config
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 15: Update SAS config...");

  const newCredential = Keypair.generate();
  const newSchema = Keypair.generate();

  const updateSasSig = await program.methods
    .updateSasConfig(newCredential.publicKey, newSchema.publicKey)
    .accountsPartial({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Update SAS config", sig: updateSasSig });

  // Restore original SAS config
  const restoreSasSig = await program.methods
    .updateSasConfig(sasCredential.publicKey, sasSchema.publicKey)
    .accountsPartial({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Restore SAS config", sig: restoreSasSig });
  console.log(`  OK: ${explorerLink(restoreSasSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 16: Reject deposit
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 16: Reject deposit flow...");

  const rejectAmount = new BN(500_000_000);
  const reqDep3Sig = await program.methods
    .requestDeposit(rejectAmount)
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      assetMint,
      investorTokenAccount: investorAta.address,
      depositVault,
      investmentRequest,
      attestation,
      frozenAccount,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Request deposit (reject test)", sig: reqDep3Sig });

  const rejectSig = await program.methods
    .rejectDeposit()
    .accountsPartial({
      manager: payer.publicKey,
      vault,
      investmentRequest,
      investor: investor.publicKey,
      depositVault,
      investorTokenAccount: investorAta.address,
      assetMint,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  results.push({ step: "Reject deposit", sig: rejectSig });
  console.log(`  OK: ${explorerLink(rejectSig)}`);
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
    console.log(`  ${r.step.padEnd(35)} ${explorerLink(r.sig)}`);
  }

  console.log();
  console.log(`All ${results.length} steps completed successfully!`);
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
