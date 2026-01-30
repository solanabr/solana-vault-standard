/**
 * WASM Bridge for solana-zk-sdk
 *
 * This module provides the interface for when official JavaScript WASM bindings
 * to the solana-zk-sdk become available (expected later in 2025).
 *
 * Current Status (January 2025):
 * - ZK ElGamal Program: Disabled for security audit
 * - Rust SDK: Full support via spl_token_client
 * - JavaScript WASM: In development
 *
 * When bindings are available, update the implementations in:
 * - encryption.ts: deriveElGamalKeypair, deriveAesKey
 * - proofs.ts: createPubkeyValidityProofData, createEqualityProofData, createRangeProofData
 *
 * @see https://solana.com/docs/tokens/extensions/confidential-transfer
 * @see https://github.com/solana-labs/solana
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { ElGamalKeypair, AesKey } from "./types";

/**
 * Factory interface for creating WASM types
 */
interface ZkFactory<T> {
  create(...args: unknown[]): T;
}

/**
 * Interface for the solana-zk-sdk WASM module
 * This will be implemented when official bindings are released
 */
export interface SolanaZkSdk {
  /**
   * Generate an ElGamal keypair from a signer
   */
  ElGamalKeypair: {
    newFromSigner(signature: Uint8Array): ZkElGamalKeypair;
    fromSecretKey(secretKey: Uint8Array): ZkElGamalKeypair;
  };

  /**
   * Generate an AES key from a signer
   */
  AeKey: {
    newFromSigner(signature: Uint8Array): ZkAeKey;
  };

  /**
   * Proof generation functions
   */
  createPubkeyValidityProof(
    keypair: ZkElGamalKeypair,
  ): ZkPubkeyValidityProofData;

  createEqualityProof(
    keypair: ZkElGamalKeypair,
    ciphertext: ZkElGamalCiphertext,
    commitment: ZkPedersenCommitment,
    amount: bigint,
  ): ZkEqualityProofData;

  createRangeProof(
    amounts: bigint[],
    commitments: ZkPedersenCommitment[],
    blindingFactors: Uint8Array[],
  ): ZkRangeProofData;

  /**
   * Encryption/decryption functions
   */
  ElGamalCiphertext: {
    encrypt(pubkey: ZkElGamalPubkey, amount: bigint): ZkElGamalCiphertext;
    decrypt(
      ciphertext: ZkElGamalCiphertext,
      secretKey: ZkElGamalSecretKey,
    ): bigint;
  };

  createPedersenCommitment(
    amount: bigint,
    blinding: Uint8Array,
  ): ZkPedersenCommitment;
}

/**
 * WASM types (will be provided by the SDK)
 */
export interface ZkElGamalKeypair {
  publicKey(): ZkElGamalPubkey;
  secretKey(): ZkElGamalSecretKey;
  toBytes(): Uint8Array;
}

export interface ZkElGamalPubkey {
  toBytes(): Uint8Array;
}

export interface ZkElGamalSecretKey {
  toBytes(): Uint8Array;
}

export interface ZkAeKey {
  toBytes(): Uint8Array;
  encrypt(amount: bigint): Uint8Array;
  decrypt(ciphertext: Uint8Array): bigint;
}

export interface ZkElGamalCiphertext {
  toBytes(): Uint8Array;
  commitment(): Uint8Array;
  handle(): Uint8Array;
}

export interface ZkPedersenCommitment {
  toBytes(): Uint8Array;
}

export interface ZkPubkeyValidityProofData {
  toBytes(): Uint8Array;
}

export interface ZkEqualityProofData {
  toBytes(): Uint8Array;
}

export interface ZkRangeProofData {
  toBytes(): Uint8Array;
}

/**
 * WASM bridge state
 */
let wasmModule: SolanaZkSdk | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Check if WASM module is loaded
 */
export function isWasmLoaded(): boolean {
  return wasmModule !== null;
}

/**
 * Initialize the WASM module
 *
 * Call this before using any WASM-dependent functions.
 * Safe to call multiple times - will only initialize once.
 *
 * @throws Error if WASM module is not available
 */
export async function initWasm(): Promise<void> {
  if (wasmModule) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // When WASM bindings are available, import them here:
      // const wasm = await import("@solana/zk-sdk-wasm");
      // await wasm.default();
      // wasmModule = wasm;

      throw new Error(
        "solana-zk-sdk WASM bindings are not yet available. " +
          "JavaScript ZK proof generation is expected later in 2025. " +
          "For now, use Rust-based server-side proof generation or " +
          "a Wallets-as-a-Service provider.",
      );
    } catch (err) {
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/**
 * Get the loaded WASM module
 *
 * @throws Error if WASM is not initialized
 */
export function getWasmModule(): SolanaZkSdk {
  if (!wasmModule) {
    throw new Error(
      "WASM module not initialized. Call initWasm() first. " +
        "Note: WASM bindings are not yet available in JavaScript.",
    );
  }
  return wasmModule;
}

// ============ WASM-Backed Implementations ============
// These will be used when WASM bindings become available

/**
 * Derive ElGamal keypair using WASM (when available)
 */
export function deriveElGamalKeypairWasm(
  signature: Uint8Array,
): ElGamalKeypair {
  const wasm = getWasmModule();
  const zkKeypair = wasm.ElGamalKeypair.newFromSigner(signature);

  return {
    publicKey: zkKeypair.publicKey().toBytes(),
    secretKey: zkKeypair.secretKey().toBytes(),
  };
}

/**
 * Derive AES key using WASM (when available)
 */
export function deriveAesKeyWasm(signature: Uint8Array): AesKey {
  const wasm = getWasmModule();
  const zkAeKey = wasm.AeKey.newFromSigner(signature);

  return {
    key: zkAeKey.toBytes(),
  };
}

/**
 * Create pubkey validity proof using WASM (when available)
 */
export function createPubkeyValidityProofWasm(
  elgamalKeypair: ElGamalKeypair,
): Uint8Array {
  const wasm = getWasmModule();
  const zkKeypair = wasm.ElGamalKeypair.fromSecretKey(elgamalKeypair.secretKey);
  const proofData = wasm.createPubkeyValidityProof(zkKeypair);

  return proofData.toBytes();
}

/**
 * Create equality proof using WASM (when available)
 */
export function createEqualityProofWasm(
  elgamalKeypair: ElGamalKeypair,
  amount: BN,
  currentBalanceCiphertext: Uint8Array,
): Uint8Array {
  const wasm = getWasmModule();

  // Convert to WASM types
  const zkKeypair = wasm.ElGamalKeypair.fromSecretKey(elgamalKeypair.secretKey);

  // Create commitment with random blinding
  const blinding = new Uint8Array(32);
  crypto.getRandomValues(blinding);
  const commitment = wasm.createPedersenCommitment(
    BigInt(amount.toString()),
    blinding,
  );

  // Parse ciphertext (actual implementation depends on WASM API)
  // For now, this throws until WASM bindings are available
  throw new Error(
    "WASM bindings not available. Use server-side Rust for proof generation.",
  );
}

/**
 * Create range proof using WASM (when available)
 */
export function createRangeProofWasm(
  amounts: BN[],
  commitmentBlindingFactors: Uint8Array[],
): Uint8Array {
  const wasm = getWasmModule();

  const bigIntAmounts = amounts.map((a) => BigInt(a.toString()));
  const commitments = bigIntAmounts.map((amount, i) =>
    wasm.createPedersenCommitment(amount, commitmentBlindingFactors[i]),
  );

  const proofData = wasm.createRangeProof(
    bigIntAmounts,
    commitments,
    commitmentBlindingFactors,
  );

  return proofData.toBytes();
}

/**
 * Feature detection: Check if WASM proof generation is available
 */
export async function isWasmProofGenerationAvailable(): Promise<boolean> {
  try {
    await initWasm();
    return true;
  } catch {
    return false;
  }
}
