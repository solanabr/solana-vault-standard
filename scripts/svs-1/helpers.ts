/**
 * Shared helpers for SVS-1 test scripts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Svs1 } from "../../target/types/svs_1";
import * as fs from "fs";
import * as path from "path";

export const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
export const ASSET_DECIMALS = 6;
export const SHARE_DECIMALS = 9;

export function loadKeypair(keypairPath: string): Keypair {
  const expandedPath = keypairPath.replace("~", process.env.HOME || "");
  const keypairData = JSON.parse(fs.readFileSync(expandedPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

export function getVaultPDA(programId: PublicKey, assetMint: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

export function getSharesMintPDA(programId: PublicKey, vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), vault.toBuffer()],
    programId
  );
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function accountUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

/**
 * Fund an account with SOL via transfer (not airdrop - avoids rate limits)
 */
export async function fundAccount(
  connection: Connection,
  payer: Keypair,
  recipient: PublicKey,
  amountSol: number
): Promise<string> {
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: amountSol * LAMPORTS_PER_SOL,
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [payer]);
  return signature;
}

/**
 * Fund multiple accounts with SOL
 */
export async function fundAccounts(
  connection: Connection,
  payer: Keypair,
  recipients: PublicKey[],
  amountSolEach: number
): Promise<void> {
  const transaction = new Transaction();

  for (const recipient of recipients) {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: amountSolEach * LAMPORTS_PER_SOL,
      })
    );
  }

  await sendAndConfirmTransaction(connection, transaction, [payer]);
}

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs1>;
  programId: PublicKey;
}

export async function setupTest(testName: string): Promise<SetupResult> {
  console.log("\n" + "=".repeat(70));
  console.log(`  SVS-1 Test: ${testName}`);
  console.log("=".repeat(70) + "\n");

  const connection = new Connection(RPC_URL, "confirmed");
  const walletPath = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  const payer = loadKeypair(walletPath);

  console.log("Configuration:");
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Wallet: ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`  Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    console.error("\n  ERROR: Insufficient balance. Need at least 0.5 SOL.");
    process.exit(1);
  }

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "../../target/idl/svs_1.json");
  if (!fs.existsSync(idlPath)) {
    console.error("\n  ERROR: IDL not found. Run 'anchor build' first.");
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const programKeypairPath = path.join(__dirname, "../../target/deploy/svs_1-keypair.json");
  if (!fs.existsSync(programKeypairPath)) {
    console.error("\n  ERROR: Program keypair not found. Run 'anchor build' first.");
    process.exit(1);
  }

  const programKeypair = loadKeypair(programKeypairPath);
  const programId = programKeypair.publicKey;

  console.log(`  Program ID: ${programId.toBase58()}`);

  const program = new Program(idl, provider) as Program<Svs1>;

  return { connection, payer, provider, program, programId };
}
