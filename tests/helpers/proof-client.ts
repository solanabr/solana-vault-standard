/**
 * Proof backend client for SVS-3/SVS-4 integration tests.
 *
 * Calls the Rust proof backend (proofs-backend/) to generate ZK proofs
 * needed for confidential transfer operations.
 *
 * Start the backend before running tests:
 *   cd proofs-backend && cargo run
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

const BACKEND_URL = process.env.PROOF_BACKEND_URL || "http://localhost:3001";

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

/** Construct the request message for proof backend */
function constructRequestMessage(
  timestamp: number,
  tokenAccount: PublicKey,
): Uint8Array {
  const prefix = Buffer.from("SVS_PROOF_REQUEST");
  const tsBytes = Buffer.alloc(8);
  tsBytes.writeBigInt64LE(BigInt(timestamp));
  const accountBytes = tokenAccount.toBuffer();
  return Buffer.concat([prefix, tsBytes, accountBytes]);
}

/** Construct the ElGamal derivation message */
function constructElGamalMessage(tokenAccount: PublicKey): Uint8Array {
  return Buffer.concat([
    Buffer.from("ElGamalSecretKey"),
    tokenAccount.toBuffer(),
  ]);
}

/** Construct range proof request message */
function constructRangeRequestMessage(timestamp: number): Uint8Array {
  const prefix = Buffer.from("SVS_PROOF_REQUEST");
  const tsBytes = Buffer.alloc(8);
  tsBytes.writeBigInt64LE(BigInt(timestamp));
  return Buffer.concat([prefix, tsBytes, Buffer.from("range")]);
}

/** Sign a message with a Keypair (Ed25519) */
function signMessage(keypair: Keypair, message: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, keypair.secretKey);
}

/** Base64 encode bytes */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export interface PubkeyValidityProofResult {
  proofData: Uint8Array;
  elgamalPubkey: Uint8Array;
}

/**
 * Request a PubkeyValidityProof from the backend.
 * Used for configure_account.
 */
export async function requestPubkeyValidityProof(
  wallet: Keypair,
  tokenAccount: PublicKey,
): Promise<PubkeyValidityProofResult> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Sign the request message
  const requestMessage = constructRequestMessage(timestamp, tokenAccount);
  const requestSignature = signMessage(wallet, requestMessage);

  // Sign the ElGamal derivation message
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
    throw new Error(
      `Pubkey validity proof failed (${response.status}): ${text}`,
    );
  }

  const data = await response.json();
  return {
    proofData: Buffer.from(data.proof_data, "base64"),
    elgamalPubkey: Buffer.from(data.elgamal_pubkey, "base64"),
  };
}

export interface EqualityProofResult {
  proofData: Uint8Array;
}

/**
 * Request a CiphertextCommitmentEqualityProof from the backend.
 * Used for withdraw/redeem.
 */
export async function requestEqualityProof(
  wallet: Keypair,
  tokenAccount: PublicKey,
  currentCiphertext: Uint8Array,
  amount: bigint | number,
): Promise<EqualityProofResult> {
  const timestamp = Math.floor(Date.now() / 1000);

  const requestMessage = constructRequestMessage(timestamp, tokenAccount);
  const requestSignature = signMessage(wallet, requestMessage);

  const elgamalMessage = constructElGamalMessage(tokenAccount);
  const elgamalSignature = signMessage(wallet, elgamalMessage);

  const response = await fetch(`${BACKEND_URL}/api/proofs/equality`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet_pubkey: wallet.publicKey.toBase58(),
      token_account: tokenAccount.toBase58(),
      timestamp,
      request_signature: toBase64(requestSignature),
      elgamal_signature: toBase64(elgamalSignature),
      current_ciphertext: toBase64(currentCiphertext),
      amount: amount.toString(),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Equality proof failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return {
    proofData: Buffer.from(data.proof_data, "base64"),
  };
}

export interface RangeProofResult {
  proofData: Uint8Array;
}

/**
 * Request a BatchedRangeProofU64 from the backend.
 * Used for withdraw/redeem range validation.
 */
export async function requestRangeProof(
  wallet: Keypair,
  amounts: (bigint | number)[],
  commitmentBlindings: Uint8Array[],
): Promise<RangeProofResult> {
  const timestamp = Math.floor(Date.now() / 1000);

  const rangeMessage = constructRangeRequestMessage(timestamp);
  const requestSignature = signMessage(wallet, rangeMessage);

  const response = await fetch(`${BACKEND_URL}/api/proofs/range`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet_pubkey: wallet.publicKey.toBase58(),
      timestamp,
      request_signature: toBase64(requestSignature),
      amounts: amounts.map((a) => a.toString()),
      commitment_blindings: commitmentBlindings.map(toBase64),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Range proof failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return {
    proofData: Buffer.from(data.proof_data, "base64"),
  };
}

/**
 * Derive AES key from wallet signature for decryptable balance.
 * This matches the Token-2022 standard derivation.
 */
export function deriveAesKeyFromSignature(
  wallet: Keypair,
  tokenAccount: PublicKey,
): Uint8Array {
  // Sign: "AESKey" || token_account
  const message = Buffer.concat([
    Buffer.from("AESKey"),
    tokenAccount.toBuffer(),
  ]);
  const signature = signMessage(wallet, message);
  // Use first 16 bytes of signature hash as AES key
  // Match the spl-token-2022 standard derivation
  const { createHash } = require("crypto");
  const hash = createHash("sha256").update(signature).digest();
  return hash.subarray(0, 16);
}

/**
 * Create a "decryptable zero balance" (PodAeCiphertext) for configure_account.
 * This is a 36-byte AE ciphertext of the value 0.
 *
 * Format: [nonce: 12 bytes][ciphertext: 24 bytes]
 * The ciphertext is AES-GCM encryption of u64(0) with the derived AES key.
 */
export function createDecryptableZeroBalance(aesKey: Uint8Array): Uint8Array {
  // For the zero balance, we create a simple authenticated encryption
  // In the SPL standard, this is an AES-256-GCM encryption of 0u64
  // with a random nonce
  const { createCipheriv, randomBytes } = require("crypto");
  const nonce = randomBytes(12);
  const plaintext = Buffer.alloc(8); // u64(0) = 8 zero bytes

  // Pad AES key to 32 bytes for AES-256-GCM if needed
  let key = aesKey;
  if (key.length < 32) {
    const padded = Buffer.alloc(32);
    padded.set(key);
    key = padded;
  }

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // PodAeCiphertext format: nonce (12) + ciphertext (8) + tag (16) = 36 bytes
  const result = new Uint8Array(36);
  result.set(nonce, 0);
  result.set(encrypted, 12);
  result.set(authTag, 20);

  return result;
}
