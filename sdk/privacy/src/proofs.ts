import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import { ElGamalKeypair, ProofContext, ProofType } from "./types";

/** Response type for backend proof API */
interface ProofBackendResponse {
  proof_data: string;
  elgamal_pubkey?: string;
}

/**
 * ZK ElGamal Proof Program ID (mainnet/devnet)
 *
 * Native program for verifying zero-knowledge proofs for confidential transfers.
 * Patched and re-enabled following the June 2025 security fix.
 *
 * @see https://solana.com/news/post-mortem-may-2-2025
 */
export const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
  "ZkE1Gama1Proof11111111111111111111111111111",
);

/**
 * Proof context state account sizes
 * These sizes are based on the SPL Token-2022 specification
 */
const PROOF_CONTEXT_SIZES = {
  pubkeyValidity: 64, // 32-byte pubkey + 32-byte proof context
  ciphertextCommitmentEquality: 192, // Equality proof context
  batchedRangeProof: 736, // Range proof context (varies by batch size)
} as const;

/**
 * Proof data sizes (bytes)
 * From spl-token-confidential-transfer-proof-extraction
 */
export const PROOF_DATA_SIZES = {
  PubkeyValidityProofData: 64, // 32-byte pubkey + 32-byte sigma proof
  CiphertextCommitmentEqualityProofData: 192, // 64-byte ciphertext + 32-byte commitment + 96-byte proof
  BatchedRangeProofU64Data: 672, // Single amount, +64 bytes per additional amount
  BatchedRangeProofU128Data: 736, // Larger range proofs
  CiphertextValidityProofData: 160, // For transfer ciphertext validation
  ZeroBalanceProofData: 96, // For empty account verification
} as const;

/**
 * ZK Proof utilities for Token-2022 Confidential Transfers
 *
 * This module provides instruction builders for the ZK ElGamal Proof Program.
 * Full ZK proof generation requires cryptographic operations that are best
 * performed using the solana-zk-sdk (Rust) or compatible WASM bindings.
 *
 * This module provides:
 * - Proof data structure templates
 * - Context account management
 * - Instruction builders for proof verification
 *
 * @see https://solana.com/docs/tokens/extensions/confidential-transfer
 * @see https://www.solana-program.com/docs/confidential-balances/zkps
 */

/**
 * Create a PubkeyValidityProof
 *
 * This sigma protocol proof verifies that the user knows the secret key
 * corresponding to their ElGamal public key without revealing it.
 * Required for the ConfigureAccount instruction.
 *
 * Proof Structure (64 bytes total):
 * - pubkey: 32 bytes (compressed Ristretto point)
 * - proof: 32 bytes (Schnorr sigma proof)
 *
 * WARNING: This currently generates PLACEHOLDER proof data that will NOT
 * pass verification by the ZK ElGamal Proof program. For production use,
 * proof generation requires:
 * - Rust: solana-zk-sdk crate with `PubkeyValidityProofData::new(&elgamal_keypair)`
 * - JavaScript: WASM bindings (expected mid-2026) or server-side Rust proxy
 *
 * The instruction format and discriminators are correct - only the cryptographic
 * proof generation is pending JavaScript SDK support.
 *
 * @param elgamalKeypair - The user's ElGamal keypair
 * @returns PubkeyValidityProofData (64 bytes) - PLACEHOLDER DATA
 */
export function createPubkeyValidityProofData(
  elgamalKeypair: ElGamalKeypair,
): Uint8Array {
  // PubkeyValidityProofData layout (64 bytes):
  // [0..32)  - ElGamal public key
  // [32..64) - Schnorr sigma proof (commitment + response)
  const proofData = new Uint8Array(PROOF_DATA_SIZES.PubkeyValidityProofData);

  // Set ElGamal public key
  proofData.set(elgamalKeypair.publicKey, 0);

  // Generate Schnorr sigma proof
  // NOTE: In production, use solana-zk-sdk:
  // const proof = PubkeyValidityProofData::new(elgamal_keypair);
  const proof = generateSchnorrProof(elgamalKeypair);
  proofData.set(proof, 32);

  return proofData;
}

/**
 * Create a CiphertextCommitmentEqualityProof
 *
 * This sigma protocol proof verifies that a twisted ElGamal ciphertext
 * encrypts the same value as a Pedersen commitment.
 * Required for withdraw and redeem operations.
 *
 * Proof Structure (192 bytes total):
 * - source_pubkey: 32 bytes (ElGamal pubkey)
 * - source_ciphertext: 64 bytes (ElGamal ciphertext: commitment || handle)
 * - destination_commitment: 32 bytes (Pedersen commitment)
 * - proof: 64 bytes (sigma proof)
 *
 * NOTE: Actual proof generation requires solana-zk-sdk WASM bindings.
 *
 * @param elgamalKeypair - The user's ElGamal keypair
 * @param amount - The amount being withdrawn/redeemed
 * @param currentBalance - Current encrypted balance ciphertext (64 bytes)
 * @returns CiphertextCommitmentEqualityProofData (192 bytes)
 */
export function createEqualityProofData(
  elgamalKeypair: ElGamalKeypair,
  amount: BN,
  currentBalance: Uint8Array,
): Uint8Array {
  // CiphertextCommitmentEqualityProofData layout (192 bytes):
  // [0..32)    - source ElGamal pubkey
  // [32..96)   - source ciphertext (commitment 32 + handle 32)
  // [96..128)  - Pedersen commitment
  // [128..192) - sigma proof
  const proofData = new Uint8Array(
    PROOF_DATA_SIZES.CiphertextCommitmentEqualityProofData,
  );

  // Set source ElGamal public key
  proofData.set(elgamalKeypair.publicKey, 0);

  // Set source ciphertext (encrypted balance)
  proofData.set(currentBalance.slice(0, 64), 32);

  // Compute Pedersen commitment to the amount
  // NOTE: In production, use solana-zk-sdk:
  // const commitment = PedersenCommitment::new(amount, blinding);
  const commitment = computePedersenCommitment(amount);
  proofData.set(commitment, 96);

  // Generate sigma proof
  // NOTE: In production, use solana-zk-sdk:
  // const proof = CiphertextCommitmentEqualityProofData::new(...)
  const proof = generateEqualityProof(elgamalKeypair, amount, currentBalance);
  proofData.set(proof, 128);

  return proofData;
}

/**
 * Create a BatchedRangeProofU64
 *
 * This Bulletproof verifies that amounts are within the valid range
 * [0, 2^64 - 1], preventing overflow/underflow attacks.
 * Required for withdraw, redeem, and transfer operations.
 *
 * Proof Size (varies by batch):
 * - 1 amount: 672 bytes
 * - 2 amounts: 736 bytes
 * - Each additional amount: +64 bytes
 *
 * The proof aggregates multiple range proofs for efficiency,
 * proving that the new balance and transfer amount are both non-negative.
 *
 * NOTE: Bulletproof generation requires solana-zk-sdk WASM bindings.
 *
 * @param amounts - Array of amounts to prove range for
 * @param commitmentBlindingFactors - Blinding factors for Pedersen commitments
 * @returns BatchedRangeProofU64Data (672 + 64*(n-1) bytes)
 */
export function createRangeProofData(
  amounts: BN[],
  commitmentBlindingFactors: Uint8Array[],
): Uint8Array {
  // BatchedRangeProofU64Data layout:
  // - Pedersen commitments: 32 bytes each
  // - Bulletproof: ~640 bytes base + aggregation overhead
  const baseSize = PROOF_DATA_SIZES.BatchedRangeProofU64Data;
  const proofSize = baseSize + Math.max(0, amounts.length - 1) * 64;
  const proofData = new Uint8Array(proofSize);

  // NOTE: In production, use solana-zk-sdk:
  // const proof = BatchedRangeProofU64Data::new(amounts, blindings);

  // Generate commitments for each amount
  let offset = 0;
  for (let i = 0; i < amounts.length; i++) {
    const commitment = computePedersenCommitment(
      amounts[i],
      commitmentBlindingFactors[i],
    );
    proofData.set(commitment, offset);
    offset += 32;
  }

  // Generate Bulletproof (placeholder)
  const bulletproof = generateBulletproof(amounts, commitmentBlindingFactors);
  proofData.set(bulletproof, offset);

  return proofData;
}

/**
 * Create and submit a proof context state account
 *
 * Context state accounts store pre-verified proofs that can be
 * referenced by subsequent instructions in the same or later transactions.
 * This allows splitting proof verification across multiple transactions
 * when proof data exceeds the 1232-byte transaction size limit.
 *
 * Flow:
 * 1. Create context account with appropriate size
 * 2. Submit proof verification instruction
 * 3. Reference context account in subsequent Token-2022 instruction
 *
 * @param connection - Solana connection
 * @param payer - Transaction fee payer
 * @param proofType - Type of proof (determines account size)
 * @param proofData - The proof data bytes
 * @returns The context account public key and creation transaction signature
 */
export async function createProofContextAccount(
  connection: Connection,
  payer: Keypair,
  proofType: ProofType,
  proofData: Uint8Array,
): Promise<{ contextAccount: PublicKey; signature: TransactionSignature }> {
  const contextAccount = Keypair.generate();

  // Determine context account size based on proof type
  const contextSize = getProofContextSize(proofType);

  // Create account instruction
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: contextAccount.publicKey,
    lamports: await connection.getMinimumBalanceForRentExemption(contextSize),
    space: contextSize,
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
  });

  // Verify proof instruction
  const verifyProofIx = createVerifyProofInstruction(
    proofType,
    proofData,
    contextAccount.publicKey,
  );

  const transaction = new Transaction().add(createAccountIx, verifyProofIx);

  const signature = await connection.sendTransaction(transaction, [
    payer,
    contextAccount,
  ]);
  await connection.confirmTransaction(signature);

  return {
    contextAccount: contextAccount.publicKey,
    signature,
  };
}

/**
 * Get the context account size for a proof type
 */
function getProofContextSize(proofType: ProofType): number {
  switch (proofType) {
    case ProofType.PubkeyValidity:
      return PROOF_CONTEXT_SIZES.pubkeyValidity;
    case ProofType.CiphertextCommitmentEquality:
      return PROOF_CONTEXT_SIZES.ciphertextCommitmentEquality;
    case ProofType.BatchedRangeProofU64:
      return PROOF_CONTEXT_SIZES.batchedRangeProof;
    default:
      throw new Error(`Unknown proof type: ${proofType}`);
  }
}

/**
 * Create a VerifyPubkeyValidity instruction
 *
 * @param proofData - The pubkey validity proof data
 * @param contextAccount - Optional context account to store result
 * @returns Transaction instruction
 */
export function createVerifyPubkeyValidityInstruction(
  proofData: Uint8Array,
  contextAccount?: PublicKey,
): TransactionInstruction {
  return createVerifyProofInstruction(
    ProofType.PubkeyValidity,
    proofData,
    contextAccount,
  );
}

/**
 * Create a VerifyCiphertextCommitmentEquality instruction
 *
 * @param proofData - The equality proof data
 * @param contextAccount - Optional context account to store result
 * @returns Transaction instruction
 */
export function createVerifyEqualityProofInstruction(
  proofData: Uint8Array,
  contextAccount?: PublicKey,
): TransactionInstruction {
  return createVerifyProofInstruction(
    ProofType.CiphertextCommitmentEquality,
    proofData,
    contextAccount,
  );
}

/**
 * Create a VerifyBatchedRangeProofU64 instruction
 *
 * @param proofData - The range proof data
 * @param contextAccount - Optional context account to store result
 * @returns Transaction instruction
 */
export function createVerifyRangeProofInstruction(
  proofData: Uint8Array,
  contextAccount?: PublicKey,
): TransactionInstruction {
  return createVerifyProofInstruction(
    ProofType.BatchedRangeProofU64,
    proofData,
    contextAccount,
  );
}

// ============ Internal Helper Functions ============

/**
 * ZK ElGamal Proof Program instruction discriminators
 * From ProofInstruction enum in Agave's zk-elgamal-proof program
 *
 * @see https://github.com/anza-xyz/agave/blob/master/programs/zk-elgamal-proof/src/lib.rs
 */
const PROOF_INSTRUCTION_DISCRIMINATORS = {
  CloseContextState: 0,
  VerifyZeroCiphertext: 1,
  VerifyCiphertextCiphertextEquality: 2,
  VerifyCiphertextCommitmentEquality: 3,
  VerifyPubkeyValidity: 4,
  VerifyPercentageWithCap: 5,
  VerifyBatchedRangeProofU64: 6,
  VerifyBatchedRangeProofU128: 7,
  VerifyBatchedRangeProofU256: 8,
  VerifyGroupedCiphertext2HandlesValidity: 9,
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,
  VerifyGroupedCiphertext3HandlesValidity: 11,
  VerifyBatchedGroupedCiphertext3HandlesValidity: 12,
} as const;

/**
 * Get instruction discriminator for proof type
 */
function getProofTypeDiscriminator(proofType: ProofType): number {
  switch (proofType) {
    case ProofType.PubkeyValidity:
      return PROOF_INSTRUCTION_DISCRIMINATORS.VerifyPubkeyValidity; // 4
    case ProofType.CiphertextCommitmentEquality:
      return PROOF_INSTRUCTION_DISCRIMINATORS.VerifyCiphertextCommitmentEquality; // 3
    case ProofType.BatchedRangeProofU64:
      return PROOF_INSTRUCTION_DISCRIMINATORS.VerifyBatchedRangeProofU64; // 6
    default:
      throw new Error(`Unknown proof type: ${proofType}`);
  }
}

/**
 * Create a verify proof instruction
 */
function createVerifyProofInstruction(
  proofType: ProofType,
  proofData: Uint8Array,
  contextAccount?: PublicKey,
): TransactionInstruction {
  const discriminator = getProofTypeDiscriminator(proofType);

  // Instruction data: discriminator (1) + proof data
  const data = Buffer.alloc(1 + proofData.length);
  data.writeUInt8(discriminator, 0);
  data.set(proofData, 1);

  const keys = contextAccount
    ? [{ pubkey: contextAccount, isSigner: false, isWritable: true }]
    : [];

  return new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
    keys,
    data,
  });
}

// ============ Internal Proof Generation Functions ============
// NOTE: These are placeholder implementations.
// For production, use solana-zk-sdk WASM bindings.

/**
 * Generate Schnorr sigma proof for pubkey validity
 *
 * The actual proof proves knowledge of the secret key s such that
 * P = s * G (where G is the Ristretto basepoint).
 *
 * Protocol:
 * 1. Prover picks random r, computes R = r * G
 * 2. Challenge c = H(P || R)
 * 3. Response z = r + c * s
 * 4. Proof = (R, z)
 */
function generateSchnorrProof(elgamalKeypair: ElGamalKeypair): Uint8Array {
  // NOTE: In production, use solana-zk-sdk:
  // let proof = PubkeyValidityProof::new(elgamal_keypair);

  // Placeholder: deterministic based on keypair for testing
  const proof = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    proof[i] =
      (elgamalKeypair.publicKey[i] ^ elgamalKeypair.secretKey[i] ^ (i * 7)) &
      0xff;
  }
  return proof;
}

/**
 * Compute Pedersen commitment: C = v * H + r * G
 *
 * Where:
 * - v is the value (amount)
 * - H is the value basepoint
 * - r is the blinding factor
 * - G is the blinding basepoint
 */
function computePedersenCommitment(
  amount: BN,
  blinding?: Uint8Array,
): Uint8Array {
  // NOTE: In production, use solana-zk-sdk:
  // let commitment = PedersenCommitment::new(amount, blinding);

  const commitment = new Uint8Array(32);
  const amountBytes = amount.toArrayLike(Buffer, "le", 8);

  // Placeholder: hash of amount + blinding
  commitment.set(amountBytes, 0);
  if (blinding) {
    for (let i = 0; i < Math.min(blinding.length, 24); i++) {
      commitment[8 + i] = blinding[i];
    }
  }

  return commitment;
}

/**
 * Generate equality proof for ciphertext-commitment equality
 */
function generateEqualityProof(
  elgamalKeypair: ElGamalKeypair,
  amount: BN,
  currentBalance: Uint8Array,
): Uint8Array {
  // NOTE: In production, use solana-zk-sdk:
  // let proof = CiphertextCommitmentEqualityProof::new(...);

  // Placeholder: deterministic output for testing
  const proof = new Uint8Array(64);
  const amountBytes = amount.toArrayLike(Buffer, "le", 8);

  for (let i = 0; i < 64; i++) {
    proof[i] =
      (elgamalKeypair.secretKey[i % 32] ^
        (currentBalance[i % currentBalance.length] || 0) ^
        (amountBytes[i % 8] || 0)) &
      0xff;
  }

  return proof;
}

/**
 * Generate Bulletproof for range verification
 */
function generateBulletproof(
  amounts: BN[],
  blindingFactors: Uint8Array[],
): Uint8Array {
  // NOTE: In production, use solana-zk-sdk:
  // let proof = BatchedRangeProof::new(amounts, blindings, bit_length);

  // Base Bulletproof size without commitments
  const proofSize = 640 - amounts.length * 32;
  const proof = new Uint8Array(Math.max(proofSize, 64));

  // Placeholder: deterministic output
  for (let i = 0; i < proof.length; i++) {
    let byte = 0;
    for (let j = 0; j < amounts.length; j++) {
      const amountBytes = amounts[j].toArrayLike(Buffer, "le", 8);
      byte ^= amountBytes[i % 8] || 0;
      byte ^= blindingFactors[j]?.[i % 32] || 0;
    }
    proof[i] = byte & 0xff;
  }

  return proof;
}

/**
 * Close a proof context account and reclaim rent
 *
 * @param connection - Solana connection
 * @param payer - Transaction fee payer and rent recipient
 * @param contextAccount - The context account to close
 * @returns Transaction signature
 */
export async function closeProofContextAccount(
  connection: Connection,
  payer: Keypair,
  contextAccount: PublicKey,
): Promise<TransactionSignature> {
  // Close instruction - transfers lamports back to payer
  const closeIx = new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
    keys: [
      { pubkey: contextAccount, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from([PROOF_INSTRUCTION_DISCRIMINATORS.CloseContextState]), // 0
  });

  const transaction = new Transaction().add(closeIx);
  const signature = await connection.sendTransaction(transaction, [payer]);
  await connection.confirmTransaction(signature);

  return signature;
}

// ============ Backend Proof Generation ============

/**
 * Backend URL for ZK proof generation
 * Set via environment variable or configure programmatically
 */
let PROOF_BACKEND_URL =
  typeof process !== "undefined"
    ? process.env?.PROOF_BACKEND_URL || "http://localhost:3001"
    : "http://localhost:3001";

let PROOF_BACKEND_API_KEY: string | undefined;

/**
 * Configure the proof backend URL and API key
 *
 * @param url - Backend URL (e.g., "https://proofs.example.com")
 * @param apiKey - Optional API key for authentication
 */
export function configureProofBackend(url: string, apiKey?: string): void {
  PROOF_BACKEND_URL = url;
  PROOF_BACKEND_API_KEY = apiKey;
}

/**
 * Generate PubkeyValidityProof via backend
 *
 * This calls the Rust backend to generate a cryptographically valid
 * proof using the solana-zk-sdk. The backend verifies wallet ownership
 * via signature verification.
 *
 * @param wallet - The wallet keypair (for signing the request)
 * @param tokenAccount - The token account being configured
 * @returns Object containing proof data and derived ElGamal public key
 */
export async function createPubkeyValidityProofViaBackend(
  wallet: Keypair,
  tokenAccount: PublicKey,
): Promise<{ proofData: Uint8Array; elgamalPubkey: Uint8Array }> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Sign the request message using nacl
  const requestMessage = buildRequestMessage(timestamp, tokenAccount);
  const requestSignature = nacl.sign.detached(requestMessage, wallet.secretKey);

  // Sign the ElGamal derivation message
  const elgamalMessage = buildElGamalDerivationMessage(tokenAccount);
  const elgamalSignature = nacl.sign.detached(elgamalMessage, wallet.secretKey);

  const response = await fetch(
    `${PROOF_BACKEND_URL}/api/proofs/pubkey-validity`,
    {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        wallet_pubkey: wallet.publicKey.toBase58(),
        token_account: tokenAccount.toBase58(),
        timestamp,
        request_signature: Buffer.from(requestSignature).toString("base64"),
        elgamal_signature: Buffer.from(elgamalSignature).toString("base64"),
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Proof generation failed: ${error}`);
  }

  const result = (await response.json()) as ProofBackendResponse;

  return {
    proofData: Buffer.from(result.proof_data, "base64"),
    elgamalPubkey: Buffer.from(result.elgamal_pubkey || "", "base64"),
  };
}

/**
 * Generate CiphertextCommitmentEqualityProof via backend
 *
 * @param wallet - The wallet keypair
 * @param tokenAccount - The token account
 * @param currentCiphertext - Current encrypted balance (64 bytes)
 * @param amount - Amount to prove
 * @returns Proof data bytes
 */
export async function createEqualityProofViaBackend(
  wallet: Keypair,
  tokenAccount: PublicKey,
  currentCiphertext: Uint8Array,
  amount: BN,
): Promise<Uint8Array> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Sign the request message using nacl
  const requestMessage = buildRequestMessage(timestamp, tokenAccount);
  const requestSignature = nacl.sign.detached(requestMessage, wallet.secretKey);

  // Sign the ElGamal derivation message
  const elgamalMessage = buildElGamalDerivationMessage(tokenAccount);
  const elgamalSignature = nacl.sign.detached(elgamalMessage, wallet.secretKey);

  const response = await fetch(`${PROOF_BACKEND_URL}/api/proofs/equality`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      wallet_pubkey: wallet.publicKey.toBase58(),
      token_account: tokenAccount.toBase58(),
      timestamp,
      request_signature: Buffer.from(requestSignature).toString("base64"),
      elgamal_signature: Buffer.from(elgamalSignature).toString("base64"),
      current_ciphertext: Buffer.from(currentCiphertext).toString("base64"),
      amount: amount.toString(),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Equality proof generation failed: ${error}`);
  }

  const result = (await response.json()) as ProofBackendResponse;
  return Buffer.from(result.proof_data, "base64");
}

/**
 * Generate BatchedRangeProofU64 via backend
 *
 * @param wallet - The wallet keypair
 * @param amounts - Amounts to prove range for
 * @param commitmentBlindings - Blinding factors for Pedersen commitments
 * @returns Proof data bytes
 */
export async function createRangeProofViaBackend(
  wallet: Keypair,
  amounts: BN[],
  commitmentBlindings: Uint8Array[],
): Promise<Uint8Array> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Sign the range request message using nacl
  const requestMessage = buildRangeRequestMessage(timestamp);
  const requestSignature = nacl.sign.detached(requestMessage, wallet.secretKey);

  const response = await fetch(`${PROOF_BACKEND_URL}/api/proofs/range`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      wallet_pubkey: wallet.publicKey.toBase58(),
      timestamp,
      request_signature: Buffer.from(requestSignature).toString("base64"),
      amounts: amounts.map((a) => a.toString()),
      commitment_blindings: commitmentBlindings.map((b) =>
        Buffer.from(b).toString("base64"),
      ),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Range proof generation failed: ${error}`);
  }

  const result = (await response.json()) as ProofBackendResponse;
  return Buffer.from(result.proof_data, "base64");
}

/**
 * Check if the proof backend is available
 *
 * @returns true if backend is reachable and healthy
 */
export async function isProofBackendAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${PROOF_BACKEND_URL}/health`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ============ Backend Helper Functions ============

/**
 * Build headers for backend requests
 */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (PROOF_BACKEND_API_KEY) {
    headers["X-API-Key"] = PROOF_BACKEND_API_KEY;
  }

  return headers;
}

/**
 * Build the request message that must be signed by the wallet
 */
function buildRequestMessage(
  timestamp: number,
  tokenAccount: PublicKey,
): Uint8Array {
  const prefix = Buffer.from("SVS_PROOF_REQUEST");
  const timestampBytes = Buffer.alloc(8);
  timestampBytes.writeBigInt64LE(BigInt(timestamp));
  const accountBytes = tokenAccount.toBuffer();

  return Buffer.concat([prefix, timestampBytes, accountBytes]);
}

/**
 * Build the message for range proof request signature
 */
function buildRangeRequestMessage(timestamp: number): Uint8Array {
  const prefix = Buffer.from("SVS_PROOF_REQUEST");
  const timestampBytes = Buffer.alloc(8);
  timestampBytes.writeBigInt64LE(BigInt(timestamp));
  const suffix = Buffer.from("range");

  return Buffer.concat([prefix, timestampBytes, suffix]);
}

/**
 * Build the message for ElGamal key derivation signature
 * This matches the standard used by spl-token CLI
 */
function buildElGamalDerivationMessage(tokenAccount: PublicKey): Uint8Array {
  const prefix = Buffer.from("ElGamalSecretKey");
  const accountBytes = tokenAccount.toBuffer();

  return Buffer.concat([prefix, accountBytes]);
}
