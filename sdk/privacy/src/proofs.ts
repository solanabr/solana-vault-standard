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
 * @deprecated Local proof generation is not available. Use
 * {@link createPubkeyValidityProofViaBackend} for backend-assisted proof generation.
 *
 * This sigma protocol proof verifies that the user knows the secret key
 * corresponding to their ElGamal public key without revealing it.
 * Required for the ConfigureAccount instruction.
 *
 * @param elgamalKeypair - The user's ElGamal keypair
 * @returns never - always throws
 * @throws Always throws - local proof generation not available
 */
export function createPubkeyValidityProofData(
  elgamalKeypair: ElGamalKeypair,
): Uint8Array {
  throw new Error(
    "Local proof generation not available - use backend proof functions instead",
  );
}

/**
 * Create a CiphertextCommitmentEqualityProof
 *
 * @deprecated Local proof generation is not available. Use
 * {@link createEqualityProofViaBackend} for backend-assisted proof generation.
 *
 * This sigma protocol proof verifies that a twisted ElGamal ciphertext
 * encrypts the same value as a Pedersen commitment.
 * Required for withdraw and redeem operations.
 *
 * @param elgamalKeypair - The user's ElGamal keypair
 * @param amount - The amount being withdrawn/redeemed
 * @param currentBalance - Current encrypted balance ciphertext (64 bytes)
 * @returns never - always throws
 * @throws Always throws - local proof generation not available
 */
export function createEqualityProofData(
  elgamalKeypair: ElGamalKeypair,
  amount: BN,
  currentBalance: Uint8Array,
): Uint8Array {
  throw new Error(
    "Local proof generation not available - use backend proof functions instead",
  );
}

/**
 * Create a BatchedRangeProofU64
 *
 * @deprecated Local proof generation is not available. Use
 * {@link createRangeProofViaBackend} for backend-assisted proof generation.
 *
 * This Bulletproof verifies that amounts are within the valid range
 * [0, 2^64 - 1], preventing overflow/underflow attacks.
 * Required for withdraw, redeem, and transfer operations.
 *
 * @param amounts - Array of amounts to prove range for
 * @param commitmentBlindingFactors - Blinding factors for Pedersen commitments
 * @returns never - always throws
 * @throws Always throws - local proof generation not available
 */
export function createRangeProofData(
  amounts: BN[],
  commitmentBlindingFactors: Uint8Array[],
): Uint8Array {
  throw new Error(
    "Local proof generation not available - use backend proof functions instead",
  );
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

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const transaction = new Transaction().add(createAccountIx, verifyProofIx);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = payer.publicKey;

  const signature = await connection.sendTransaction(transaction, [
    payer,
    contextAccount,
  ]);
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

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
// These functions throw at runtime. Client-side ZK proof generation requires
// solana-zk-sdk WASM bindings (not yet available). Use backend proof generation
// via configureProofBackend() instead.

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
function generateSchnorrProof(_elgamalKeypair: ElGamalKeypair): Uint8Array {
  throw new Error(
    "Client-side proof generation requires solana-zk-sdk WASM bindings (not yet available). " +
      "Use backend proof generation via configureProofBackend().",
  );
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
  _amount: BN,
  _blinding?: Uint8Array,
): Uint8Array {
  throw new Error(
    "Client-side proof generation requires solana-zk-sdk WASM bindings (not yet available). " +
      "Use backend proof generation via configureProofBackend().",
  );
}

/**
 * Generate equality proof for ciphertext-commitment equality
 */
function generateEqualityProof(
  _elgamalKeypair: ElGamalKeypair,
  _amount: BN,
  _currentBalance: Uint8Array,
): Uint8Array {
  throw new Error(
    "Client-side proof generation requires solana-zk-sdk WASM bindings (not yet available). " +
      "Use backend proof generation via configureProofBackend().",
  );
}

/**
 * Generate Bulletproof for range verification
 */
function generateBulletproof(
  _amounts: BN[],
  _blindingFactors: Uint8Array[],
): Uint8Array {
  throw new Error(
    "Client-side proof generation requires solana-zk-sdk WASM bindings (not yet available). " +
      "Use backend proof generation via configureProofBackend().",
  );
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

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const transaction = new Transaction().add(closeIx);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = payer.publicKey;

  const signature = await connection.sendTransaction(transaction, [payer]);
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return signature;
}

// ============ Clock Drift Validation ============

/**
 * Maximum allowed clock drift (in seconds) between local time and cluster time.
 * If the local clock is off by more than this, proof timestamps may be rejected.
 */
const MAX_CLOCK_DRIFT_SECONDS = 60;

/**
 * Validate that the local clock is reasonably close to cluster time.
 *
 * This is a sanity check to prevent proof timestamps from being rejected
 * by the backend when the client's clock is drastically off. The check is
 * non-fatal if the RPC call fails (network issues shouldn't block proof
 * generation), but throws if clock drift exceeds MAX_CLOCK_DRIFT_SECONDS.
 *
 * @param connection - Solana connection to query cluster time
 * @param localTimestamp - Local unix timestamp in seconds
 * @throws If local clock is more than 60 seconds off from cluster time
 */
async function validateClockDrift(
  connection: Connection,
  localTimestamp: number,
): Promise<void> {
  try {
    const slot = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);
    if (blockTime && Math.abs(localTimestamp - blockTime) > MAX_CLOCK_DRIFT_SECONDS) {
      throw new Error(
        `Local clock is ${Math.abs(localTimestamp - blockTime)}s off from cluster time — proof timestamps may be rejected`,
      );
    }
  } catch (e) {
    // Re-throw clock drift errors; swallow RPC failures
    if (e instanceof Error && e.message.includes("off from cluster time")) {
      throw e;
    }
    // Non-fatal: proceed with local timestamp if RPC check fails
  }
}

// ============ Backend Proof Generation ============

/**
 * Backend URL for ZK proof generation
 * Set via environment variable or configure programmatically
 */
let PROOF_BACKEND_URL =
  typeof process !== "undefined"
    ? process.env?.PROOF_BACKEND_URL || "https://localhost:3001"
    : "https://localhost:3001";

let PROOF_BACKEND_API_KEY: string | undefined;
let PROOF_BACKEND_ALLOW_INSECURE = false;

/**
 * Configure the proof backend URL, API key, and trust acknowledgment.
 *
 * **SECURITY WARNING — Backend Trust Model:**
 * Backend proof generation sends secret key material (wallet signatures used to
 * derive ElGamal secret keys) to the configured backend server. The backend can
 * reconstruct the user's ElGamal keypair and decrypt all confidential balances.
 *
 * Consider these mitigations:
 * - Run the proof backend in a trusted execution environment (TEE/SGX)
 * - Use TLS certificate pinning for the backend connection
 * - Audit the backend source code and deploy from verified builds
 * - Prefer client-side WASM proof generation when available
 *
 * Each backend proof function requires `acknowledgeBackendTrust: true` as a
 * parameter to confirm the caller accepts the trust model per-invocation.
 *
 * @param url - Backend URL (e.g., "https://proofs.example.com"). Must use HTTPS
 *   unless `allowInsecure` is set or `NODE_ENV === 'test'`.
 * @param apiKey - Optional API key for authentication
 * @param options - Optional configuration
 * @param options.allowInsecure - Allow plaintext HTTP URLs (NOT recommended for production)
 * @throws If URL uses plaintext HTTP without explicit opt-in
 */
export function configureProofBackend(
  url: string,
  apiKey?: string,
  options?: { allowInsecure?: boolean },
): void {
  const isTest =
    typeof process !== "undefined" && process.env?.NODE_ENV === "test";
  const allowInsecure = options?.allowInsecure === true || isTest;

  if (url.startsWith("http://") && !allowInsecure) {
    throw new Error(
      "Proof backend URL must use HTTPS. Plaintext HTTP exposes secret key material in transit. " +
        "Pass { allowInsecure: true } to override (NOT recommended for production), " +
        "or set NODE_ENV=test for local development.",
    );
  }

  PROOF_BACKEND_URL = url;
  PROOF_BACKEND_API_KEY = apiKey;
  PROOF_BACKEND_ALLOW_INSECURE = allowInsecure;
}

/**
 * Assert that backend trust has been explicitly acknowledged per-call.
 * @internal
 */
function assertBackendTrustAcknowledged(acknowledgeBackendTrust: boolean): void {
  if (!acknowledgeBackendTrust) {
    throw new Error(
      "Backend proof generation sends secret key material to a remote server. " +
        "The backend can reconstruct ElGamal keypairs and decrypt confidential balances. " +
        "Pass acknowledgeBackendTrust=true to confirm you accept this trust model.",
    );
  }
}

/**
 * Generate PubkeyValidityProof via backend
 *
 * This calls the Rust backend to generate a cryptographically valid
 * proof using the solana-zk-sdk. The backend verifies wallet ownership
 * via signature verification.
 *
 * **SECURITY WARNING — Secret Key Material Sent to Backend:**
 * This function sends wallet signatures (`requestSignature`, `elgamalSignature`)
 * to the backend server. The `elgamalSignature` is used by the backend to derive
 * the user's ElGamal secret key — meaning the backend can decrypt all confidential
 * balances for this token account. The backend MUST be trusted.
 *
 * @param wallet - The wallet keypair (for signing the request)
 * @param tokenAccount - The token account being configured
 * @param acknowledgeBackendTrust - Must be `true` to confirm you accept that the
 *   backend receives secret key material and must be fully trusted
 * @param connection - Optional Solana connection for client-side clock drift validation.
 *   When provided, the local timestamp is checked against cluster time to catch
 *   clock skew before sending the request to the backend.
 * @returns Object containing proof data and derived ElGamal public key
 * @throws If acknowledgeBackendTrust is not true
 * @throws If local clock is more than 60 seconds off from cluster time (when connection provided)
 */
export async function createPubkeyValidityProofViaBackend(
  wallet: Keypair,
  tokenAccount: PublicKey,
  acknowledgeBackendTrust: boolean,
  connection?: Connection,
): Promise<{ proofData: Uint8Array; elgamalPubkey: Uint8Array }> {
  assertBackendTrustAcknowledged(acknowledgeBackendTrust);

  const timestamp = Math.floor(Date.now() / 1000);

  // V5-S11: Sanity check local clock against cluster time if connection available
  if (connection) {
    await validateClockDrift(connection, timestamp);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(16));

  // Sign the request message using nacl (nonce bound to prevent replay)
  const requestMessage = buildRequestMessage(timestamp, tokenAccount, nonce);
  const requestSignature = nacl.sign.detached(requestMessage, wallet.secretKey);

  // Sign the ElGamal derivation message (bound to same timestamp + nonce)
  // WARNING: The backend uses this signature to derive the ElGamal secret key
  const elgamalMessage = buildElGamalDerivationMessage(tokenAccount, timestamp, nonce);
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
        nonce: Buffer.from(nonce).toString("base64"),
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
 * **SECURITY WARNING — Secret Key Material Sent to Backend:**
 * This function sends wallet signatures to the backend server. The
 * `elgamalSignature` allows the backend to derive the user's ElGamal secret key,
 * granting it the ability to decrypt all confidential balances for this token
 * account. The backend MUST be trusted.
 *
 * @param wallet - The wallet keypair
 * @param tokenAccount - The token account
 * @param currentCiphertext - Current encrypted balance (64 bytes)
 * @param amount - Amount to prove
 * @param acknowledgeBackendTrust - Must be `true` to confirm you accept that the
 *   backend receives secret key material and must be fully trusted
 * @param connection - Optional Solana connection for client-side clock drift validation.
 *   When provided, the local timestamp is checked against cluster time to catch
 *   clock skew before sending the request to the backend.
 * @returns Proof data bytes
 * @throws If acknowledgeBackendTrust is not true
 * @throws If local clock is more than 60 seconds off from cluster time (when connection provided)
 */
export async function createEqualityProofViaBackend(
  wallet: Keypair,
  tokenAccount: PublicKey,
  currentCiphertext: Uint8Array,
  amount: BN,
  acknowledgeBackendTrust: boolean,
  connection?: Connection,
): Promise<Uint8Array> {
  assertBackendTrustAcknowledged(acknowledgeBackendTrust);

  const timestamp = Math.floor(Date.now() / 1000);

  // V5-S11: Sanity check local clock against cluster time if connection available
  if (connection) {
    await validateClockDrift(connection, timestamp);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(16));

  // Sign the request message using nacl (nonce bound to prevent replay)
  const requestMessage = buildRequestMessage(timestamp, tokenAccount, nonce);
  const requestSignature = nacl.sign.detached(requestMessage, wallet.secretKey);

  // Sign the ElGamal derivation message (bound to same timestamp + nonce)
  // WARNING: The backend uses this signature to derive the ElGamal secret key
  const elgamalMessage = buildElGamalDerivationMessage(tokenAccount, timestamp, nonce);
  const elgamalSignature = nacl.sign.detached(elgamalMessage, wallet.secretKey);

  const response = await fetch(`${PROOF_BACKEND_URL}/api/proofs/equality`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      wallet_pubkey: wallet.publicKey.toBase58(),
      token_account: tokenAccount.toBase58(),
      timestamp,
      nonce: Buffer.from(nonce).toString("base64"),
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
 * **SECURITY WARNING — Secret Key Material Sent to Backend:**
 * This function sends wallet signatures and commitment blinding factors to the
 * backend server. The blinding factors are secret values; if compromised, an
 * attacker can break the hiding property of the Pedersen commitments and learn
 * the committed amounts. The backend MUST be trusted.
 *
 * @param wallet - The wallet keypair
 * @param amounts - Amounts to prove range for
 * @param commitmentBlindings - Blinding factors for Pedersen commitments
 * @param acknowledgeBackendTrust - Must be `true` to confirm you accept that the
 *   backend receives secret key material and must be fully trusted
 * @param connection - Optional Solana connection for client-side clock drift validation.
 *   When provided, the local timestamp is checked against cluster time to catch
 *   clock skew before sending the request to the backend.
 * @returns Proof data bytes
 * @throws If acknowledgeBackendTrust is not true
 * @throws If local clock is more than 60 seconds off from cluster time (when connection provided)
 */
export async function createRangeProofViaBackend(
  wallet: Keypair,
  amounts: BN[],
  commitmentBlindings: Uint8Array[],
  acknowledgeBackendTrust: boolean,
  connection?: Connection,
): Promise<Uint8Array> {
  assertBackendTrustAcknowledged(acknowledgeBackendTrust);

  const timestamp = Math.floor(Date.now() / 1000);

  // V5-S11: Sanity check local clock against cluster time if connection available
  if (connection) {
    await validateClockDrift(connection, timestamp);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(16));

  // Sign the range request message using nacl (nonce bound to prevent replay)
  const requestMessage = buildRangeRequestMessage(timestamp, nonce);
  const requestSignature = nacl.sign.detached(requestMessage, wallet.secretKey);

  const response = await fetch(`${PROOF_BACKEND_URL}/api/proofs/range`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      wallet_pubkey: wallet.publicKey.toBase58(),
      timestamp,
      nonce: Buffer.from(nonce).toString("base64"),
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
 * Build the request message that must be signed by the wallet.
 *
 * Includes a 16-byte random nonce to prevent replay attacks. The nonce
 * is sent alongside the signature so the backend can reconstruct the
 * message for verification.
 */
function buildRequestMessage(
  timestamp: number,
  tokenAccount: PublicKey,
  nonce: Uint8Array,
): Uint8Array {
  const prefix = Buffer.from("SVS_PROOF_REQUEST");
  const timestampBytes = Buffer.alloc(8);
  timestampBytes.writeBigInt64LE(BigInt(timestamp));
  const accountBytes = tokenAccount.toBuffer();

  return Buffer.concat([prefix, timestampBytes, accountBytes, Buffer.from(nonce)]);
}

/**
 * Build the message for range proof request signature.
 *
 * Includes a 16-byte random nonce to prevent replay attacks.
 */
function buildRangeRequestMessage(
  timestamp: number,
  nonce: Uint8Array,
): Uint8Array {
  const prefix = Buffer.from("SVS_PROOF_REQUEST");
  const timestampBytes = Buffer.alloc(8);
  timestampBytes.writeBigInt64LE(BigInt(timestamp));
  const suffix = Buffer.from("range");

  return Buffer.concat([prefix, timestampBytes, suffix, Buffer.from(nonce)]);
}

/**
 * Build the message for ElGamal key derivation signature.
 *
 * Binds the signature to the specific proof request via the caller's
 * timestamp and nonce, preventing replay attacks. The backend must
 * validate that the timestamp is within a reasonable window (e.g., 5 minutes)
 * and that the nonce has not been seen before.
 */
function buildElGamalDerivationMessage(
  tokenAccount: PublicKey,
  timestamp: number,
  nonce: Uint8Array,
): Uint8Array {
  const prefix = Buffer.from("ElGamalSecretKey");
  const accountBytes = tokenAccount.toBuffer();
  const timestampBytes = Buffer.alloc(8);
  timestampBytes.writeBigUInt64LE(BigInt(timestamp));

  return Buffer.concat([prefix, accountBytes, timestampBytes, Buffer.from(nonce)]);
}
