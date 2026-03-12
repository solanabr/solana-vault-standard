/**
 * SVS-11 Credit Markets Vault — End-to-End Devnet Lifecycle Script
 *
 * Exercises every SVS-11 instruction on devnet:
 *   1.  Create asset mint & fund wallet
 *   2.  Set oracle price (mock oracle)
 *   3.  Create attestation (mock attestation program)
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
 *   14. Update attester config
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
import { Svs11 } from "../target/types/svs_11";
import { MockOracle } from "../target/types/mock_oracle";
import { MockSas as MockAttestation } from "../target/types/mock_sas";
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
import {
  getCreditVaultAddress,
  getCreditSharesMintAddress,
  getRedemptionEscrowAddress,
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableTokensAddress,
  getCreditFrozenAccountAddress,
} from "../sdk/core/src/credit-vault-pda";

const PROGRAM_ID = new PublicKey("Bf17gDR2JdKTWdoTWK3Va9YQtkpePRAAVxMCaokj8ZFW");
const MOCK_ORACLE_ID = new PublicKey("EbFcZZApkGcX6LqRmzSWVLasnDM457wY4WvhJRnVjdZF");
const ATTESTATION_PROGRAM_ID = new PublicKey("4azCqYgLHDRmsiR6kmYu6v5qvzamaYGqZcmx8MrnrKMc");
const PRICE_SCALE = new BN(1_000_000_000);

function explorerLink(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function accountLink(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

// PDA helpers — Mock Oracle
function getOracleDataPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    MOCK_ORACLE_ID,
  );
}

// PDA helpers — Mock Attestation
function getAttestationPDA(subject: PublicKey, issuer: PublicKey, attestationType: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("attestation"), subject.toBuffer(), issuer.toBuffer(), Buffer.from([attestationType])],
    ATTESTATION_PROGRAM_ID,
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
  const attestationIdl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../target/idl/mock_sas.json"), "utf-8"));

  const program = new Program<Svs11>(svs11Idl, provider);
  const oracleProgram = new Program<MockOracle>(oracleIdl, provider);
  const attestationProgram = new Program<MockAttestation>(attestationIdl, provider);

  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  console.log(`Program ID:     ${PROGRAM_ID.toBase58()}`);
  console.log(`Mock Oracle:    ${MOCK_ORACLE_ID.toBase58()}`);
  console.log(`Attestation:    ${ATTESTATION_PROGRAM_ID.toBase58()}`);
  console.log(`Payer:          ${payer.publicKey.toBase58()}`);
  console.log(`RPC:            ${connection.rpcEndpoint}`);

  const vaultId = new BN(Date.now() % 100000);
  console.log(`Vault ID:       ${vaultId.toString()}`);
  console.log();

  const results: { step: string; sig: string }[] = [];

  const attester = Keypair.generate();
  const investor = Keypair.generate();
  const attestationType = 0; // KYC
  const countryCode = [66, 82]; // "BR"

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
  const [vault] = getCreditVaultAddress(PROGRAM_ID, assetMint, vaultId);
  const [sharesMint] = getCreditSharesMintAddress(PROGRAM_ID, vault);
  const [redemptionEscrow] = getRedemptionEscrowAddress(PROGRAM_ID, vault);
  const depositVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);
  const [investmentRequest] = getInvestmentRequestAddress(PROGRAM_ID, vault, investor.publicKey);
  const [redemptionRequest] = getRedemptionRequestAddress(PROGRAM_ID, vault, investor.publicKey);
  const [claimableTokens] = getClaimableTokensAddress(PROGRAM_ID, vault, investor.publicKey);

  const [navOracle] = getOracleDataPDA();

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
  // Step 3: Create attestation for investor
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 3: Creating attestation for investor...");

  const expiresAt = new BN(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  const [attestation] = getAttestationPDA(investor.publicKey, attester.publicKey, attestationType);

  const attSig = await attestationProgram.methods
    .createAttestation(attester.publicKey, attestationType, countryCode, expiresAt)
    .accountsPartial({
      authority: payer.publicKey,
      attestation,
      subject: investor.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  results.push({ step: "Create attestation", sig: attSig });
  console.log(`  Attestation: ${attestation.toBase58()}`);
  console.log(`  OK: ${explorerLink(attSig)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────
  // Step 4: Initialize credit vault
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 4: Initializing credit vault...");

  const initSig = await program.methods
    .initializePool(
      vaultId,
      new BN(1_000_000), // 1 token minimum
      new BN(3600),
    )
    .accountsPartial({
      authority: payer.publicKey,
      manager: payer.publicKey,
      assetMint,
      navOracle,
      oracleProgram: MOCK_ORACLE_ID,
      attester: attester.publicKey,
      attestationProgram: ATTESTATION_PROGRAM_ID,
      vault,
      sharesMint,
      depositVault,
      redemptionEscrow,
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
      frozenCheck: null,
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
      investor: investor.publicKey,
      navOracle,
      attestation,
      frozenCheck: null,
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  results.push({ step: "Approve deposit", sig: appDepSig });
  console.log(`  Approve deposit: ${explorerLink(appDepSig)}`);

  const investorSharesAta = getAssociatedTokenAddressSync(
    sharesMint, investor.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );

  // Create Token-2022 ATA for investor shares before claiming
  await getOrCreateAssociatedTokenAccount(
    connection, payer, sharesMint, investor.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );

  const claimDepSig = await program.methods
    .claimDeposit()
    .accountsPartial({
      investor: investor.publicKey,
      vault,
      investmentRequest,
      sharesMint,
      investorSharesAccount: investorSharesAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
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
      frozenCheck: null,
      token2022Program: TOKEN_2022_PROGRAM_ID,
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
      investor: investor.publicKey,
      assetMint,
      depositVault,
      sharesMint,
      redemptionEscrow,
      claimableTokens,
      navOracle,
      attestation,
      frozenCheck: null,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
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
      frozenCheck: null,
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

  const cancelRedeemShares = new BN(100_000_000); // small amount
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
      frozenCheck: null,
      token2022Program: TOKEN_2022_PROGRAM_ID,
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
      token2022Program: TOKEN_2022_PROGRAM_ID,
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
      destination: managerAta.address,
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

  const [frozenAccountPda] = getCreditFrozenAccountAddress(PROGRAM_ID, vault, investor.publicKey);

  // Anchor 0.31+ omits `investor` from the accountsPartial type since it
  // appears in frozenAccount PDA seeds, but the runtime still requires it.
  // Using a variable avoids TS excess-property checking on object literals.
  const freezeAccounts = {
    manager: payer.publicKey,
    vault,
    investor: investor.publicKey,
    frozenAccount: frozenAccountPda,
  };
  const freezeSig = await program.methods
    .freezeAccount()
    .accountsPartial(freezeAccounts)
    .rpc();

  results.push({ step: "Freeze account", sig: freezeSig });
  console.log(`  Freeze: ${explorerLink(freezeSig)}`);

  const unfreezeAccounts = {
    manager: payer.publicKey,
    vault,
    frozenAccount: frozenAccountPda,
  };
  const unfreezeSig = await program.methods
    .unfreezeAccount()
    .accountsPartial(unfreezeAccounts)
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
  // Step 15: Update attester config
  // ─────────────────────────────────────────────────────────────────────
  console.log("Step 15: Update attester config...");

  const newAttester = Keypair.generate();
  const newAttestationProgram = Keypair.generate();

  const updateAttesterSig = await program.methods
    .updateAttester(newAttester.publicKey, newAttestationProgram.publicKey)
    .accountsPartial({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Update attester config", sig: updateAttesterSig });

  // Restore original attester config
  const restoreAttesterSig = await program.methods
    .updateAttester(attester.publicKey, ATTESTATION_PROGRAM_ID)
    .accountsPartial({ authority: payer.publicKey, vault })
    .rpc();

  results.push({ step: "Restore attester config", sig: restoreAttesterSig });
  console.log(`  OK: ${explorerLink(restoreAttesterSig)}`);
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
      frozenCheck: null,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([investor])
    .rpc();

  results.push({ step: "Request deposit (reject test)", sig: reqDep3Sig });

  const rejectSig = await program.methods
    .rejectDeposit(0)
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
