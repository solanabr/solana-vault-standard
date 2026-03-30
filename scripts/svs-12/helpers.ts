/**
 * Shared helpers for SVS-12 Tranched Vault test scripts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Connection,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Svs12 } from "../../target/types/svs_12";
import * as fs from "fs";
import * as path from "path";

export const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
export const ASSET_DECIMALS = 6;
export const LAMPORTS_PER_ASSET = 10 ** ASSET_DECIMALS;

export function loadKeypair(keypairPath: string): Keypair {
  const expandedPath = keypairPath.replace("~", process.env.HOME || "");
  const keypairData = JSON.parse(fs.readFileSync(expandedPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function accountUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

export function getVaultPDA(programId: PublicKey, assetMint: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tranched_vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

export function getTranchePDA(programId: PublicKey, vault: PublicKey, index: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tranche"), vault.toBuffer(), Buffer.from([index])],
    programId,
  );
}

export function getSharesMintPDA(programId: PublicKey, vault: PublicKey, index: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), vault.toBuffer(), Buffer.from([index])],
    programId,
  );
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

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs12>;
  programId: PublicKey;
}

export async function setupTest(testName: string): Promise<SetupResult> {
  console.log("\n" + "=".repeat(70));
  console.log(`  SVS-12 Test: ${testName}`);
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

  const idlPath = path.join(__dirname, "../../target/idl/svs_12.json");
  if (!fs.existsSync(idlPath)) {
    console.error("\n  ERROR: IDL not found. Run 'anchor build' first.");
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const programKeypairPath = path.join(__dirname, "../../target/deploy/svs_12-keypair.json");
  if (!fs.existsSync(programKeypairPath)) {
    console.error("\n  ERROR: Program keypair not found. Run 'anchor build' first.");
    process.exit(1);
  }

  const programKeypair = loadKeypair(programKeypairPath);
  const programId = programKeypair.publicKey;

  console.log(`  Program ID: ${programId.toBase58()}`);

  const program = new Program(idl, provider) as Program<Svs12>;

  return { connection, payer, provider, program, programId };
}

export interface VaultSetupResult {
  assetMint: PublicKey;
  userAta: PublicKey;
  vault: PublicKey;
  assetVault: PublicKey;
  vaultId: BN;
  seniorTranche: PublicKey;
  juniorTranche: PublicKey;
  seniorSharesMint: PublicKey;
  juniorSharesMint: PublicKey;
  userSeniorSharesAta: PublicKey;
  userJuniorSharesAta: PublicKey;
}

/**
 * Create asset mint, initialize vault, add senior+junior tranches, create user ATAs.
 * Returns all addresses needed for subsequent operations.
 */
export async function setupVaultWithTranches(
  setup: SetupResult,
  options?: { seniorSub?: number; seniorYield?: number; seniorCap?: number },
): Promise<VaultSetupResult> {
  const { connection, payer, program, programId } = setup;
  const seniorSub = options?.seniorSub ?? 2000;
  const seniorYield = options?.seniorYield ?? 500;
  const seniorCap = options?.seniorCap ?? 6000;

  // Create asset mint
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );
  console.log(`  Asset Mint: ${assetMint.toBase58()}`);

  // Mint tokens to payer
  const userAtaAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false,
    undefined, undefined, TOKEN_PROGRAM_ID,
  );
  await mintTo(
    connection, payer, assetMint, userAtaAccount.address,
    payer.publicKey, 10_000_000 * LAMPORTS_PER_ASSET, [], undefined, TOKEN_PROGRAM_ID,
  );

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, assetMint, vaultId);
  const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);

  // Initialize vault
  const initSig = await program.methods
    .initialize(vaultId, 0)
    .accountsStrict({
      authority: payer.publicKey,
      vault,
      assetMint,
      assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  Initialize vault: ${explorerUrl(initSig)}`);

  // Add senior tranche
  const [seniorTranche] = getTranchePDA(programId, vault, 0);
  const [seniorSharesMint] = getSharesMintPDA(programId, vault, 0);
  const seniorSig = await program.methods
    .addTranche(0, seniorSub, seniorYield, seniorCap)
    .accountsStrict({
      authority: payer.publicKey,
      vault,
      tranche: seniorTranche,
      sharesMint: seniorSharesMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(`  Add senior tranche: ${explorerUrl(seniorSig)}`);

  // Add junior tranche
  const [juniorTranche] = getTranchePDA(programId, vault, 1);
  const [juniorSharesMint] = getSharesMintPDA(programId, vault, 1);
  const juniorSig = await program.methods
    .addTranche(1, 0, 0, 10000)
    .accountsStrict({
      authority: payer.publicKey,
      vault,
      tranche: juniorTranche,
      sharesMint: juniorSharesMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(`  Add junior tranche: ${explorerUrl(juniorSig)}`);

  // Create shares ATAs for user
  const userJuniorSharesAtaAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, juniorSharesMint, payer.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );
  const userSeniorSharesAtaAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, seniorSharesMint, payer.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );

  return {
    assetMint,
    userAta: userAtaAccount.address,
    vault,
    assetVault,
    vaultId,
    seniorTranche,
    juniorTranche,
    seniorSharesMint,
    juniorSharesMint,
    userSeniorSharesAta: userSeniorSharesAtaAccount.address,
    userJuniorSharesAta: userJuniorSharesAtaAccount.address,
  };
}
