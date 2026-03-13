/**
 * Cross-module helpers for devnet test scripts.
 *
 * Shared by scripts/svs-1, scripts/svs-10, etc.
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Connection,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "fs";

export const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

export function loadKeypair(keypairPath: string): Keypair {
  const expandedPath = keypairPath.replace("~", process.env.HOME || "");
  const keypairData = JSON.parse(fs.readFileSync(expandedPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

export function loadProgramId(programKeypairPath: string): PublicKey {
  const kp = loadKeypair(programKeypairPath);
  return kp.publicKey;
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function accountUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

export async function fundAccount(
  connection: Connection,
  payer: Keypair,
  recipient: PublicKey,
  amountSol: number,
): Promise<string> {
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: amountSol * LAMPORTS_PER_SOL,
    }),
  );

  return sendAndConfirmTransaction(connection, transaction, [payer]);
}

export async function fundAccounts(
  connection: Connection,
  payer: Keypair,
  recipients: PublicKey[],
  amountSolEach: number,
): Promise<void> {
  const transaction = new Transaction();

  for (const recipient of recipients) {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: amountSolEach * LAMPORTS_PER_SOL,
      }),
    );
  }

  await sendAndConfirmTransaction(connection, transaction, [payer]);
}

export interface BaseSetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  programId: PublicKey;
}

export interface SetupOptions {
  testName: string;
  moduleName: string;
  idlPath: string;
  programKeypairPath: string;
  minBalanceSol?: number;
}

export async function baseSetup(opts: SetupOptions): Promise<BaseSetupResult> {
  const { testName, moduleName, idlPath, programKeypairPath, minBalanceSol = 0.5 } = opts;

  console.log("\n" + "=".repeat(70));
  console.log(`  ${moduleName} Test: ${testName}`);
  console.log("=".repeat(70) + "\n");

  const connection = new Connection(RPC_URL, "confirmed");
  const walletPath = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  const payer = loadKeypair(walletPath);

  console.log("Configuration:");
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Wallet: ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`  Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < minBalanceSol * LAMPORTS_PER_SOL) {
    console.error(`\n  ERROR: Insufficient balance. Need at least ${minBalanceSol} SOL.`);
    process.exit(1);
  }

  if (!fs.existsSync(idlPath)) {
    console.error("\n  ERROR: IDL not found. Run 'anchor build' first.");
    process.exit(1);
  }

  if (!fs.existsSync(programKeypairPath)) {
    console.error("\n  ERROR: Program keypair not found. Run 'anchor build' first.");
    process.exit(1);
  }

  const programId = loadProgramId(programKeypairPath);
  console.log(`  Program ID: ${programId.toBase58()}`);

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  return { connection, payer, provider, programId };
}
