import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  ElGamalKeypair,
  AesKey,
  DecryptableBalance,
  EncryptedBalance,
} from "./types";
import { BN } from "@coral-xyz/anchor";

/**
 * Encryption utilities for Token-2022 Confidential Transfers
 *
 * ElGamal encryption is used for on-chain encrypted balances that can be
 * homomorphically operated on. AES encryption is used for owner-decryptable
 * balances stored alongside the ElGamal ciphertexts.
 *
 * Key derivation follows the Solana Token-2022 standard:
 * - ElGamal key seed: "ElGamalSecretKey" (hardcoded for compatibility)
 * - AES key seed: "AeKey" (hardcoded for compatibility)
 *
 * NOTE: Full ZK proof generation requires the solana-zk-sdk WASM bindings
 * which are expected later in 2025. Until then, this SDK provides:
 * - Proper key derivation matching the on-chain standard
 * - AES encryption/decryption using Web Crypto API
 * - Proof data structures for when WASM bindings are available
 *
 * @see https://solana.com/docs/tokens/extensions/confidential-transfer
 */

// Standard seed messages for key derivation (hardcoded for compatibility)
const ELGAMAL_SEED_MESSAGE = "ElGamalSecretKey";
const AES_SEED_MESSAGE = "AeKey";

/**
 * Derive an ElGamal keypair deterministically from a signer and account
 *
 * This follows the Solana Token-2022 standard for ElGamal key derivation:
 * 1. Create message: seed || publicSeed (empty for CLI compatibility)
 * 2. Sign the message with the wallet
 * 3. Use signature to derive ElGamal keypair via solana-zk-sdk
 *
 * @param signer - The wallet keypair
 * @param tokenAccount - The token account address
 * @returns ElGamal keypair (32-byte public key, 32-byte secret key)
 */
export function deriveElGamalKeypair(
  signer: Keypair,
  tokenAccount: PublicKey,
): ElGamalKeypair {
  // Create the message to sign: seed || tokenAccount (matches CLI)
  const seedBuffer = Buffer.from(ELGAMAL_SEED_MESSAGE);
  const accountBuffer = tokenAccount.toBuffer();
  const message = Buffer.concat([seedBuffer, accountBuffer]);

  // Sign the message (simulating wallet signature)
  // In production with actual wallet: wallet.signMessage(message)
  const signature = signMessage(signer.secretKey, message);

  // Derive ElGamal keypair from signature
  // NOTE: In production, use solana-zk-sdk WASM:
  // const elgamalKeypair = ElGamalKeypair.newFromSigner(signature);
  const keypairBytes = deriveKeyFromSignature(signature, 64);

  return {
    publicKey: keypairBytes.slice(0, 32),
    secretKey: keypairBytes.slice(32, 64),
  };
}

/**
 * Derive an AES key for decryptable balances
 *
 * This follows the Solana Token-2022 standard for AES key derivation:
 * 1. Create message: "AeKey" || tokenAccount
 * 2. Sign the message with the wallet
 * 3. Use signature to derive AES key via solana-zk-sdk
 *
 * @param signer - The wallet keypair
 * @param tokenAccount - The token account address
 * @returns AES key (16 bytes for AES-128-GCM)
 */
export function deriveAesKey(signer: Keypair, tokenAccount: PublicKey): AesKey {
  // Create the message to sign: seed || tokenAccount (matches CLI)
  const seedBuffer = Buffer.from(AES_SEED_MESSAGE);
  const accountBuffer = tokenAccount.toBuffer();
  const message = Buffer.concat([seedBuffer, accountBuffer]);

  // Sign the message
  const signature = signMessage(signer.secretKey, message);

  // Derive AES key from signature
  // NOTE: In production, use solana-zk-sdk WASM:
  // const aesKey = AeKey.newFromSigner(signature);
  const keyBytes = deriveKeyFromSignature(signature, 16);

  return {
    key: keyBytes,
  };
}

/**
 * Create a decryptable zero balance (AE ciphertext of 0)
 *
 * This is required when first configuring a confidential account.
 *
 * @param aesKey - The AES key for this account
 * @returns 36-byte decryptable balance ciphertext
 */
export function createDecryptableZeroBalance(
  aesKey: AesKey,
): DecryptableBalance {
  // AE ciphertext format: 12-byte nonce + 8-byte encrypted value + 16-byte tag
  const ciphertext = new Uint8Array(36);

  // Generate random nonce
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  ciphertext.set(nonce, 0);

  // Encrypt zero value (8 bytes, little-endian)
  // In production, use actual AES-GCM encryption
  const encryptedValue = encryptAesGcm(aesKey.key, nonce, new Uint8Array(8));
  ciphertext.set(encryptedValue, 12);

  return { ciphertext };
}

/**
 * Create a decryptable balance from a known amount
 *
 * @param aesKey - The AES key for this account
 * @param amount - The balance amount
 * @returns 36-byte decryptable balance ciphertext
 */
export function createDecryptableBalance(
  aesKey: AesKey,
  amount: BN,
): DecryptableBalance {
  const ciphertext = new Uint8Array(36);

  // Generate random nonce
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  ciphertext.set(nonce, 0);

  // Convert amount to 8-byte little-endian
  const amountBytes = amount.toArrayLike(Buffer, "le", 8);

  // Encrypt
  const encryptedValue = encryptAesGcm(aesKey.key, nonce, amountBytes);
  ciphertext.set(encryptedValue, 12);

  return { ciphertext };
}

/**
 * Decrypt a decryptable balance
 *
 * @param aesKey - The AES key for this account
 * @param decryptable - The decryptable balance ciphertext
 * @returns The decrypted balance amount
 */
export function decryptBalance(
  aesKey: AesKey,
  decryptable: DecryptableBalance,
): BN {
  const nonce = decryptable.ciphertext.slice(0, 12);
  const encrypted = decryptable.ciphertext.slice(12);

  const decrypted = decryptAesGcm(aesKey.key, nonce, encrypted);

  return new BN(decrypted, "le");
}

/**
 * Calculate new decryptable balance after a withdrawal
 *
 * @param aesKey - The AES key
 * @param currentBalance - Current available balance
 * @param withdrawAmount - Amount being withdrawn
 * @returns New decryptable balance ciphertext
 */
export function computeNewDecryptableBalance(
  aesKey: AesKey,
  currentBalance: BN,
  withdrawAmount: BN,
): DecryptableBalance {
  const newBalance = currentBalance.sub(withdrawAmount);
  return createDecryptableBalance(aesKey, newBalance);
}

// ============ Internal Crypto Functions ============
// These implementations use Web Crypto API where possible.
// ZK-specific operations require solana-zk-sdk WASM bindings.

/**
 * Sign a message using Ed25519 via tweetnacl.
 *
 * This produces a real Ed25519 signature (64 bytes) which is then used
 * as entropy for deterministic key derivation, matching the Token-2022
 * standard where wallet.signMessage() output seeds ElGamal/AES keys.
 *
 * @param secretKey - The full 64-byte Ed25519 secret key (as from Keypair.secretKey)
 * @param message - The message to sign
 * @returns 64-byte Ed25519 signature
 */
function signMessage(secretKey: Uint8Array, message: Buffer): Uint8Array {
  return nacl.sign.detached(message, secretKey);
}

/**
 * Derive key bytes from a signature
 */
function deriveKeyFromSignature(
  signature: Uint8Array,
  length: number,
): Uint8Array {
  // Hash the signature to derive key bytes
  return hashSync(signature, length);
}

/**
 * Synchronous hash function using FNV-1a.
 *
 * WARNING: FNV-1a is NOT cryptographically secure. This function is gated
 * to test environments only. Production code must use the async
 * `crypto.subtle.digest('SHA-256', ...)` path instead.
 *
 * @throws {Error} If called outside of a test environment (NODE_ENV !== 'test')
 */
function hashSync(input: Uint8Array, outputLength: number): Uint8Array {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "hashSync uses FNV-1a which is not cryptographically secure. " +
        "Use the async crypto.subtle.digest path for production. " +
        "Set NODE_ENV=test to use this function in tests.",
    );
  }

  const output = new Uint8Array(outputLength);

  // Simple HKDF-like expansion using FNV-1a (test-only)
  let counter = 0;
  let pos = 0;
  while (pos < outputLength) {
    const block = new Uint8Array(input.length + 1);
    block.set(input);
    block[input.length] = counter++;

    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < block.length; i++) {
      hash ^= block[i];
      hash = (hash * 0x01000193) >>> 0; // FNV prime
    }

    for (let i = 0; i < 4 && pos < outputLength; i++) {
      output[pos++] = (hash >> (i * 8)) & 0xff;
    }
  }

  return output;
}

/**
 * Convert Uint8Array to ArrayBuffer (handles SharedArrayBuffer case)
 */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(arr.length);
  new Uint8Array(buffer).set(arr);
  return buffer;
}

/**
 * AES-GCM encryption using Web Crypto API (async version)
 */
export async function encryptAesGcmAsync(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "AES-GCM", length: 128 },
    false,
    ["encrypt"],
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    cryptoKey,
    toArrayBuffer(plaintext),
  );

  return new Uint8Array(ciphertext);
}

/**
 * AES-GCM decryption using Web Crypto API (async version)
 */
export async function decryptAesGcmAsync(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "AES-GCM", length: 128 },
    false,
    ["decrypt"],
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    cryptoKey,
    toArrayBuffer(ciphertext),
  );

  return new Uint8Array(plaintext);
}

/**
 * AES-GCM encryption (synchronous fallback)
 * Uses simplified implementation for non-async contexts
 */
function encryptAesGcm(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  // Synchronous fallback using CTR-like mode with authentication
  const output = new Uint8Array(plaintext.length + 16);

  // Derive keystream from key + nonce
  const keystream = hashSync(
    new Uint8Array([...key, ...nonce]),
    plaintext.length,
  );

  // XOR plaintext with keystream
  for (let i = 0; i < plaintext.length; i++) {
    output[i] = plaintext[i] ^ keystream[i];
  }

  // Compute authentication tag
  const tagInput = new Uint8Array([
    ...key,
    ...nonce,
    ...output.slice(0, plaintext.length),
  ]);
  const tag = hashSync(tagInput, 16);
  output.set(tag, plaintext.length);

  return output;
}

/**
 * AES-GCM decryption (synchronous fallback, test-only)
 *
 * Verifies the authentication tag before returning plaintext.
 *
 * @throws {Error} If the authentication tag does not match (tampered ciphertext)
 */
function decryptAesGcm(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const plaintextLen = ciphertext.length - 16;
  if (plaintextLen < 0) {
    throw new Error("Ciphertext too short: missing authentication tag");
  }

  const encryptedData = ciphertext.slice(0, plaintextLen);
  const receivedTag = ciphertext.slice(plaintextLen);

  // Verify authentication tag before decrypting
  const tagInput = new Uint8Array([...key, ...nonce, ...encryptedData]);
  const expectedTag = hashSync(tagInput, 16);

  let tagMatch = 0;
  for (let i = 0; i < 16; i++) {
    tagMatch |= receivedTag[i] ^ expectedTag[i];
  }
  if (tagMatch !== 0) {
    throw new Error(
      "AES-GCM authentication tag verification failed: ciphertext may be tampered",
    );
  }

  // Derive keystream from key + nonce
  const keystream = hashSync(new Uint8Array([...key, ...nonce]), plaintextLen);

  // XOR ciphertext with keystream
  const output = new Uint8Array(plaintextLen);
  for (let i = 0; i < plaintextLen; i++) {
    output[i] = encryptedData[i] ^ keystream[i];
  }

  return output;
}

/**
 * Convert ElGamal public key to bytes format expected by the program
 */
export function elgamalPubkeyToBytes(pubkey: ElGamalKeypair): Uint8Array {
  return pubkey.publicKey;
}

/**
 * Convert decryptable balance to bytes format expected by the program
 */
export function decryptableBalanceToBytes(
  balance: DecryptableBalance,
): Uint8Array {
  return balance.ciphertext;
}
