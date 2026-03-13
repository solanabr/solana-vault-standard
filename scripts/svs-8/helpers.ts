/**
 * Shared helpers for SVS-8 scripts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Svs8 } from "../../target/types/svs_8";
import * as fs from "fs";
import * as path from "path";

export const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
export const ASSET_DECIMALS = 6;
export const SHARE_DECIMALS = 9;
export const PRICE_SCALE = 1_000_000_000;

export const MULTI_VAULT_SEED = Buffer.from("multi_vault");
export const ASSET_ENTRY_SEED = Buffer.from("asset_entry");
export const SHARES_SEED = Buffer.from("shares");
export const ORACLE_PRICE_SEED = Buffer.from("oracle_price");

export function loadKeypair(keypairPath: string): Keypair {
  const expandedPath = keypairPath.replace("~", process.env.HOME || "");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expandedPath, "utf-8"))));
}

export function getVaultPDA(programId: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MULTI_VAULT_SEED, vaultId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

export function getSharesMintPDA(programId: PublicKey, vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SHARES_SEED, vault.toBuffer()], programId);
}

export function getAssetEntryPDA(programId: PublicKey, vault: PublicKey, assetMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ASSET_ENTRY_SEED, vault.toBuffer(), assetMint.toBuffer()],
    programId
  );
}

export function getOraclePricePDA(programId: PublicKey, vault: PublicKey, assetMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ORACLE_PRICE_SEED, vault.toBuffer(), assetMint.toBuffer()],
    programId
  );
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function accountUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

export async function fundAccount(connection: Connection, payer: Keypair, recipient: PublicKey, amountSol: number): Promise<void> {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient,
    lamports: amountSol * LAMPORTS_PER_SOL,
  }));
  await sendAndConfirmTransaction(connection, tx, [payer]);
}

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs8>;
  programId: PublicKey;
}

export async function setupScript(scriptName: string): Promise<SetupResult> {
  console.log("\n" + "=".repeat(70));
  console.log(`  SVS-8 Script: ${scriptName}`);
  console.log("=".repeat(70) + "\n");

  const connection = new Connection(RPC_URL, "confirmed");
  const walletPath = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  const payer = loadKeypair(walletPath);

  console.log("Configuration:");
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Wallet: ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

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

  const idlPath = path.join(__dirname, "../../target/idl/svs_8.json");
  if (!fs.existsSync(idlPath)) {
    console.error("\n  ERROR: IDL not found. Run 'anchor build' first.");
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const programId = new PublicKey("E8bGqwitsaFELBtuhbwAKwVBKjAjGzrfcnBPishvvRsA");
  console.log(`  Program ID: ${programId.toBase58()}`);

  const program = new Program(idl, provider) as Program<Svs8>;
  return { connection, payer, provider, program, programId };
}
