/**
 * Shared proof helpers for SVS-3/SVS-4 devnet test scripts.
 *
 * Adapted from tests/helpers/proof-client.ts for standalone script use.
 * Calls the Rust proof backend to generate ZK proofs for confidential transfers.
 *
 * Start the backend before running tests:
 *   cd proofs-backend && cargo run
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as nacl from "tweetnacl";

const BACKEND_URL = process.env.PROOF_BACKEND_URL || "http://localhost:3001";

export const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
  "ZkE1Gama1Proof11111111111111111111111111111"
);

// ProofContextState sizes
export const EQUALITY_CONTEXT_SIZE = 33 + 128; // 161 bytes
export const RANGE_CONTEXT_SIZE = 33 + 264; // 297 bytes

/** Check if the proof backend is reachable */
export async function isBackendAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${BACKEND_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check backend availability and exit gracefully if not running.
 * Call this at the start of SVS-3/4 scripts.
 */
export async function requireBackend(): Promise<void> {
  const available = await isBackendAvailable();
  if (!available) {
    console.log("\n  ⚠  Proof backend not running — skipping this test.");
    console.log("     Start with: cd proofs-backend && cargo run\n");
    process.exit(0);
  }
}

function constructRequestMessage(timestamp: number, tokenAccount: PublicKey): Uint8Array {
  const prefix = Buffer.from("SVS_PROOF_REQUEST");
  const tsBytes = Buffer.alloc(8);
  tsBytes.writeBigInt64LE(BigInt(timestamp));
  return Buffer.concat([prefix, tsBytes, tokenAccount.toBuffer()]);
}

function constructElGamalMessage(tokenAccount: PublicKey): Uint8Array {
  return Buffer.concat([Buffer.from("ElGamalSecretKey"), tokenAccount.toBuffer()]);
}

function constructRangeRequestMessage(timestamp: number): Uint8Array {
  const prefix = Buffer.from("SVS_PROOF_REQUEST");
  const tsBytes = Buffer.alloc(8);
  tsBytes.writeBigInt64LE(BigInt(timestamp));
  return Buffer.concat([prefix, tsBytes, Buffer.from("range")]);
}

function signMessage(keypair: Keypair, message: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, keypair.secretKey);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export interface PubkeyValidityProofResult {
  proofData: Uint8Array;
  elgamalPubkey: Uint8Array;
}

export async function requestPubkeyValidityProof(
  wallet: Keypair,
  tokenAccount: PublicKey,
): Promise<PubkeyValidityProofResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestMessage = constructRequestMessage(timestamp, tokenAccount);
  const requestSignature = signMessage(wallet, requestMessage);
  const elgamalMessage = constructElGamalMessage(tokenAccount);
  const elgamalSignature = signMessage(wallet, elgamalMessage);

  const response = await fetch(`${BACKEND_URL}/api/proofs/pubkey-validity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet_pubkey: wallet.publicKey.toBase58(),
      token_account: tokenAccount.toBase58(),
      timestamp,
      request_signature: toBase64(requestSignature),
      elgamal_signature: toBase64(elgamalSignature),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pubkey validity proof failed (${response.status}): ${text}`);
  }

  const data = await response.json() as any;
  return {
    proofData: Buffer.from(data.proof_data, "base64"),
    elgamalPubkey: Buffer.from(data.elgamal_pubkey, "base64"),
  };
}

export interface WithdrawProofResult {
  equalityProof: Uint8Array;
  rangeProof: Uint8Array;
}

export async function requestWithdrawProof(
  wallet: Keypair,
  tokenAccount: PublicKey,
  currentCiphertext: Uint8Array,
  currentBalance: bigint | number,
  withdrawAmount: bigint | number,
): Promise<WithdrawProofResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const requestMessage = constructRequestMessage(timestamp, tokenAccount);
  const requestSignature = signMessage(wallet, requestMessage);
  const elgamalMessage = constructElGamalMessage(tokenAccount);
  const elgamalSignature = signMessage(wallet, elgamalMessage);

  const response = await fetch(`${BACKEND_URL}/api/proofs/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet_pubkey: wallet.publicKey.toBase58(),
      token_account: tokenAccount.toBase58(),
      timestamp,
      request_signature: toBase64(requestSignature),
      elgamal_signature: toBase64(elgamalSignature),
      current_ciphertext: toBase64(currentCiphertext),
      current_balance: currentBalance.toString(),
      withdraw_amount: withdrawAmount.toString(),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Withdraw proof failed (${response.status}): ${text}`);
  }

  const data = await response.json() as any;
  return {
    equalityProof: Buffer.from(data.equality_proof, "base64"),
    rangeProof: Buffer.from(data.range_proof, "base64"),
  };
}

export function deriveAesKeyFromSignature(wallet: Keypair, tokenAccount: PublicKey): Uint8Array {
  const message = Buffer.concat([Buffer.from("AESKey"), tokenAccount.toBuffer()]);
  const signature = signMessage(wallet, message);
  const { createHash } = require("crypto");
  return createHash("sha256").update(signature).digest().subarray(0, 16);
}

export function createDecryptableZeroBalance(aesKey: Uint8Array): Uint8Array {
  const { createCipheriv, randomBytes } = require("crypto");
  const nonce = randomBytes(12);
  const plaintext = Buffer.alloc(8);

  let key = aesKey;
  if (key.length < 32) {
    const padded = Buffer.alloc(32);
    padded.set(key);
    key = padded;
  }

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const result = new Uint8Array(36);
  result.set(nonce, 0);
  result.set(encrypted, 12);
  result.set(authTag, 20);
  return result;
}

export function createDecryptableBalance(aesKey: Uint8Array, amount: bigint | number): Uint8Array {
  const { createCipheriv, randomBytes } = require("crypto");
  const nonce = randomBytes(12);
  const plaintext = Buffer.alloc(8);
  plaintext.writeBigUInt64LE(BigInt(amount));

  let key = aesKey;
  if (key.length < 32) {
    const padded = Buffer.alloc(32);
    padded.set(key);
    key = padded;
  }

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const result = new Uint8Array(36);
  result.set(nonce, 0);
  result.set(encrypted, 12);
  result.set(authTag, 20);
  return result;
}

export async function readAvailableBalanceCiphertext(
  connection: Connection,
  tokenAccount: PublicKey,
): Promise<Uint8Array> {
  const accountInfo = await connection.getAccountInfo(tokenAccount);
  if (!accountInfo) throw new Error("Token account not found");

  const data = accountInfo.data;
  let offset = 166;

  while (offset + 4 <= data.length) {
    const extType = data.readUInt16LE(offset);
    const extLen = data.readUInt16LE(offset + 2);
    if (extType === 0 && extLen === 0) break;
    if (extType === 5) {
      const extStart = offset + 4;
      const availableBalanceOffset = extStart + 1 + 32 + 64 + 64;
      return data.subarray(availableBalanceOffset, availableBalanceOffset + 64);
    }
    offset += 4 + extLen;
  }

  throw new Error("ConfidentialTransferAccount extension not found");
}

/**
 * Create a context state account and verify proof into it.
 * Split into 2 transactions for range proofs (exceed single-tx size).
 */
export async function createProofContext(
  provider: anchor.AnchorProvider,
  payer: Keypair,
  proofDiscriminator: number,
  proofData: Uint8Array,
  contextSize: number,
): Promise<PublicKey> {
  const connection = provider.connection;
  const contextKeypair = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(contextSize);

  // Tx 1: Create account owned by ZK ElGamal proof program
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: contextKeypair.publicKey,
    lamports,
    space: contextSize,
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
  });
  const createTx = new Transaction().add(createAccountIx);
  await provider.sendAndConfirm(createTx, [payer, contextKeypair]);

  // Tx 2: Verify proof into the account
  const verifyIx = new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
    keys: [
      { pubkey: contextKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([proofDiscriminator]), proofData]),
  });
  const verifyTx = new Transaction().add(verifyIx);
  await provider.sendAndConfirm(verifyTx);

  return contextKeypair.publicKey;
}
