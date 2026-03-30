/**
 * SVS-10 Async Vault — Shared helpers for devnet test scripts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { baseSetup, explorerUrl, accountUrl, fundAccount } from "../shared/common-helpers";
import type { BaseSetupResult } from "../shared/common-helpers";
import {
  deriveAsyncVaultAddresses,
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableTokensAddress,
  getOperatorApprovalAddress,
} from "../../sdk/core/src/async-vault-pda";

export {
  explorerUrl,
  accountUrl,
  fundAccount,
  deriveAsyncVaultAddresses,
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableTokensAddress,
  getOperatorApprovalAddress,
};

export const ASSET_DECIMALS = 6;

export interface Svs10SetupResult extends BaseSetupResult {
  program: Program;
}

export async function setupTest(testName: string): Promise<Svs10SetupResult> {
  const idlPath = path.join(__dirname, "../../target/idl/svs_10.json");
  const programKeypairPath = path.join(__dirname, "../../target/deploy/svs_10-keypair.json");

  const base = await baseSetup({
    testName,
    moduleName: "SVS-10",
    idlPath,
    programKeypairPath,
    minBalanceSol: 1,
  });

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, base.provider);

  return { ...base, program };
}

export interface TestResult {
  name: string;
  passed: boolean;
}

export interface VaultContext {
  vault: PublicKey;
  sharesMint: PublicKey;
  shareEscrow: PublicKey;
  assetVault: PublicKey;
  assetMint: PublicKey;
  userAta: PublicKey;
  userSharesAta: PublicKey;
  vaultId: BN;
}

/**
 * Create asset mint, fund wallet, derive all vault PDAs, and initialize the vault.
 * Returns a VaultContext with everything needed for subsequent instructions.
 */
export async function createAndInitializeVault(
  setup: Svs10SetupResult,
  opts?: { mintAmount?: number; vaultId?: BN },
): Promise<VaultContext> {
  const { connection, payer, program, programId } = setup;
  const mintAmount = opts?.mintAmount ?? 10_000_000_000;
  const vaultId = opts?.vaultId ?? new BN(Date.now() % 100000);

  console.log("\n--- Setup: Creating asset mint and initializing vault ---");

  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );
  console.log(`  Asset mint: ${assetMint.toBase58()}`);

  const userAtaAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );
  const userAta = userAtaAccount.address;

  await mintTo(connection, payer, assetMint, userAta, payer, mintAmount);
  console.log(`  Minted: ${mintAmount / 10 ** ASSET_DECIMALS} tokens`);

  const addrs = deriveAsyncVaultAddresses(programId, assetMint, vaultId);
  const { vault, sharesMint, shareEscrow } = addrs;
  const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);

  console.log(`  Vault PDA: ${vault.toBase58()}`);
  console.log(`  Vault ID:  ${vaultId.toString()}`);

  const initSig = await program.methods
    .initialize(vaultId, "SVS-10 Test Vault", "SVS10")
    .accounts({
      authority: payer.publicKey,
      operator: payer.publicKey,
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

  console.log(`  Initialized: ${explorerUrl(initSig)}`);

  const userSharesAta = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );

  return { vault, sharesMint, shareEscrow, assetVault, assetMint, userAta, userSharesAta, vaultId };
}

/**
 * Full deposit cycle: request -> fulfill -> claim. Returns the claim tx signature.
 */
export async function depositCycle(
  setup: Svs10SetupResult,
  ctx: VaultContext,
  amount: BN,
): Promise<{ reqSig: string; fulSig: string; claimSig: string }> {
  const { payer, program, programId } = setup;
  const [depositRequest] = getDepositRequestAddress(programId, ctx.vault, payer.publicKey);

  const reqSig = await program.methods
    .requestDeposit(amount, payer.publicKey)
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

  const fulSig = await program.methods
    .fulfillDeposit(null)
    .accountsStrict({
      operator: payer.publicKey,
      vault: ctx.vault,
      depositRequest,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  const claimSig = await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: payer.publicKey,
      vault: ctx.vault,
      depositRequest,
      owner: payer.publicKey,
      sharesMint: ctx.sharesMint,
      receiverSharesAccount: ctx.userSharesAta,
      receiver: payer.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { reqSig, fulSig, claimSig };
}

/**
 * Full redeem cycle: request -> fulfill -> claim. Returns the claim tx signature.
 */
export async function redeemCycle(
  setup: Svs10SetupResult,
  ctx: VaultContext,
  shares: BN,
): Promise<{ reqSig: string; fulSig: string; claimSig: string }> {
  const { payer, program, programId } = setup;
  const [redeemRequest] = getRedeemRequestAddress(programId, ctx.vault, payer.publicKey);
  const [claimableTokens] = getClaimableTokensAddress(programId, ctx.vault, payer.publicKey);

  const reqSig = await program.methods
    .requestRedeem(shares, payer.publicKey)
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

  const fulSig = await program.methods
    .fulfillRedeem(null)
    .accountsStrict({
      operator: payer.publicKey,
      vault: ctx.vault,
      redeemRequest,
      operatorApproval: programId,
      assetMint: ctx.assetMint,
      assetVault: ctx.assetVault,
      sharesMint: ctx.sharesMint,
      shareEscrow: ctx.shareEscrow,
      claimableTokens,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  const claimSig = await program.methods
    .claimRedeem()
    .accountsStrict({
      claimant: payer.publicKey,
      vault: ctx.vault,
      assetMint: ctx.assetMint,
      redeemRequest,
      owner: payer.publicKey,
      claimableTokens,
      receiverAssetAccount: ctx.userAta,
      receiver: payer.publicKey,
      operatorApproval: programId,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { reqSig, fulSig, claimSig };
}

export function printSummary(
  results: { step: string; sig: string }[],
  vault: PublicKey,
  programId: PublicKey,
): void {
  console.log("\n" + "=".repeat(70));
  console.log("  RESULTS SUMMARY");
  console.log("=".repeat(70));
  console.log();
  console.log(`Program:  ${programId.toBase58()}`);
  console.log(`Vault:    ${vault.toBase58()}`);
  console.log(`Explorer: ${accountUrl(vault.toBase58())}`);
  console.log();

  for (const r of results) {
    console.log(`  ${r.step.padEnd(30)} ${explorerUrl(r.sig)}`);
  }

  console.log();
  console.log(`All ${results.length} steps completed successfully!`);
  console.log("=".repeat(70) + "\n");
}
