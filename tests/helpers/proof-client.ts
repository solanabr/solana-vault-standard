/**
 * Proof backend client for SVS-3/SVS-4 integration tests.
 *
 * Calls the Rust proof backend (proofs-backend/) to generate ZK proofs
 * needed for confidential transfer operations.
 *
 * Start the backend before running tests:
 *   cd proofs-backend && cargo run
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
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
  const { createCipheriv, randomBytes } = require("crypto");
  const nonce = randomBytes(12);
  const plaintext = Buffer.alloc(8); // u64(0) = 8 zero bytes

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

/**
 * Create an encrypted decryptable balance for a given amount.
 * Used for new_decryptable_available_balance in withdraw/redeem.
 */
export function createDecryptableBalance(
  aesKey: Uint8Array,
  amount: bigint | number,
): Uint8Array {
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

export interface WithdrawProofResult {
  equalityProof: Uint8Array;
  rangeProof: Uint8Array;
}

/**
 * Request combined withdraw proofs (equality + range) from the backend.
 * The backend computes remaining_balance and generates both proofs
 * with a shared Pedersen opening.
 */
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

  const data = await response.json();
  return {
    equalityProof: Buffer.from(data.equality_proof, "base64"),
    rangeProof: Buffer.from(data.range_proof, "base64"),
  };
}

/**
 * Read the available balance ElGamal ciphertext from a CT-enabled token account.
 *
 * ExtensionType::ConfidentialTransferAccount = 5 in Token-2022's TLV encoding.
 *
 * CT extension data layout (295 bytes):
 *   approved (1) + elgamal_pubkey (32) + pending_lo (64) + pending_hi (64)
 *   = offset 161 for available_balance (64 bytes)
 */
export async function readAvailableBalanceCiphertext(
  connection: Connection,
  tokenAccount: PublicKey,
): Promise<Uint8Array> {
  const accountInfo = await connection.getAccountInfo(tokenAccount);
  if (!accountInfo) throw new Error("Token account not found");

  const data = accountInfo.data;

  // Token-2022: base account (165) + account type byte (1) = 166, then TLV extensions
  let offset = 166;

  while (offset + 4 <= data.length) {
    const extType = data.readUInt16LE(offset);
    const extLen = data.readUInt16LE(offset + 2);

    if (extType === 0 && extLen === 0) break;

    if (extType === 5) {
      // ConfidentialTransferAccount (ExtensionType = 5)
      const extStart = offset + 4;
      // approved(1) + elgamal_pubkey(32) + pending_lo(64) + pending_hi(64) = 161
      const availableBalanceOffset = extStart + 1 + 32 + 64 + 64;
      return data.subarray(availableBalanceOffset, availableBalanceOffset + 64);
    }

    offset += 4 + extLen;
  }

  throw new Error("ConfidentialTransferAccount extension not found");
}
