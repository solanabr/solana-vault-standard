/**
 * Shared helpers for all SVS devnet test scripts.
 * Generic utilities that work across SVS-1, SVS-2, SVS-3, SVS-4.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN, Idl } from "@coral-xyz/anchor";
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
import * as path from "path";

export const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
export const ASSET_DECIMALS = 6;
export const SHARE_DECIMALS = 9;

export type SvsVariant = "svs_1" | "svs_2" | "svs_3" | "svs_4" | "svs_5" | "svs_6";

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
  return sendAndConfirmTransaction(connection, transaction, [payer]);
}

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

export interface SetupResult<T extends Idl = Idl> {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<T>;
  programId: PublicKey;
}

export async function setupTest<T extends Idl = Idl>(
  testName: string,
  svsVariant: SvsVariant
): Promise<SetupResult<T>> {
  const label = svsVariant.toUpperCase().replace("_", "-");
  console.log("\n" + "=".repeat(70));
  console.log(`  ${label} Test: ${testName}`);
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

  const idlPath = path.join(__dirname, `../../target/idl/${svsVariant}.json`);
  if (!fs.existsSync(idlPath)) {
    console.error(`\n  ERROR: IDL not found at ${idlPath}. Run 'anchor build' first.`);
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const programId = new PublicKey(idl.address);

  console.log(`  Program ID: ${programId.toBase58()}`);

  const program = new Program(idl, provider) as unknown as Program<T>;

  return { connection, payer, provider, program, programId };
}
