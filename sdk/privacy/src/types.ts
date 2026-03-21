import { PublicKey, Keypair, TransactionSignature } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

/**
 * Cryptographic constants for confidential transfers
 */
export const CRYPTO_SIZES = {
  // ElGamal
  ELGAMAL_PUBKEY: 32, // Compressed Ristretto point
  ELGAMAL_SECRET_KEY: 32, // Scalar
  ELGAMAL_CIPHERTEXT: 64, // commitment (32) + handle (32)

  // AES-128-GCM
  AES_KEY: 16, // 128 bits
  AES_NONCE: 12, // 96 bits
  AES_TAG: 16, // 128 bits
  DECRYPTABLE_BALANCE: 36, // nonce (12) + encrypted (8) + tag (16)

  // Pedersen
  PEDERSEN_COMMITMENT: 32, // Compressed Ristretto point
  PEDERSEN_BLINDING: 32, // Scalar

  // Proof data sizes
  PUBKEY_VALIDITY_PROOF: 64,
  EQUALITY_PROOF: 192,
  RANGE_PROOF_U64_BASE: 672,
  RANGE_PROOF_U64_PER_AMOUNT: 64,
  CIPHERTEXT_VALIDITY_PROOF: 160,
  ZERO_BALANCE_PROOF: 96,
} as const;

/**
 * ElGamal keypair for confidential transfers
 *
 * The public key is a compressed Ristretto point.
 * The secret key is a curve25519 scalar.
 *
 * Key derivation: sign("ElGamalSecretKey" || tokenAccount) → secret → public
 */
export interface ElGamalKeypair {
  publicKey: Uint8Array; // 32 bytes (compressed Ristretto)
  secretKey: Uint8Array; // 32 bytes (scalar)
}

/**
 * AES-128-GCM key for decryptable balances
 *
 * Used to encrypt the available balance so only the owner can decrypt it.
 * The program stores encrypted balances that can be decrypted client-side.
 *
 * Key derivation: sign("AeKey" || tokenAccount) → AES key
 */
export interface AesKey {
  key: Uint8Array; // 16 bytes (AES-128)
}

/**
 * Encrypted balance (ElGamal ciphertext)
 *
 * The twisted ElGamal ciphertext consists of:
 * - commitment: v * H + r * G (Pedersen commitment to the value)
 * - handle: r * P (for decryption)
 *
 * Where v = value, r = randomness, H = value basepoint, G = blinding basepoint, P = pubkey
 */
export interface EncryptedBalance {
  commitment: Uint8Array; // 32 bytes (Pedersen commitment)
  handle: Uint8Array; // 32 bytes (decryption handle)
}

/**
 * Decryptable balance (AES-GCM encrypted)
 *
 * Format: nonce (12) || ciphertext (8) || tag (16) = 36 bytes
 *
 * This allows the owner to decrypt their balance without brute-forcing
 * the ElGamal ciphertext (which would be computationally expensive).
 */
export interface DecryptableBalance {
  ciphertext: Uint8Array; // 36 bytes
}

/**
 * Proof context state account
 *
 * Stores a pre-verified proof that can be referenced by
 * subsequent instructions in the same or later transactions.
 */
export interface ProofContext {
  account: PublicKey;
  proofType: ProofType;
}

/**
 * Types of ZK proofs used in confidential transfers
 *
 * @see https://www.solana-program.com/docs/confidential-balances/zkps
 */
export enum ProofType {
  /**
   * Sigma protocol proving knowledge of ElGamal secret key
   * Required for: ConfigureAccount
   */
  PubkeyValidity = "pubkey_validity",

  /**
   * Sigma protocol proving ciphertext encrypts same value as commitment
   * Required for: Withdraw, Redeem, Transfer
   */
  CiphertextCommitmentEquality = "ciphertext_commitment_equality",

  /**
   * Bulletproof proving amounts are in valid range [0, 2^64)
   * Required for: Withdraw, Redeem, Transfer
   */
  BatchedRangeProofU64 = "batched_range_proof_u64",

  /**
   * Sigma protocol proving ciphertext encrypts zero
   * Required for: EmptyAccount
   */
  ZeroBalance = "zero_balance",

  /**
   * Sigma protocol proving ciphertext is valid ElGamal encryption
   * Required for: Transfer (ciphertext validity)
   */
  CiphertextValidity = "ciphertext_validity",

  /**
   * Sigma protocol proving fee was calculated correctly
   * Required for: TransferWithFee
   */
  FeeSigma = "fee_sigma",
}

/**
 * Location of proof data in the instruction
 */
export enum ProofLocation {
  /**
   * Proof data is included directly in the instruction data
   * Use when proof fits in transaction size limit
   */
  InstructionOffset = "instruction_offset",

  /**
   * Proof was pre-verified and stored in a context account
   * Use when proof is too large for single transaction
   */
  ContextStateAccount = "context_state_account",
}

/**
 * Parameters for configuring a confidential account
 */
export interface ConfigureAccountParams {
  vault: PublicKey;
  userSharesAccount: PublicKey;
  elgamalKeypair: ElGamalKeypair;
  aesKey: AesKey;
}

/**
 * Parameters for confidential deposit
 */
export interface ConfidentialDepositParams {
  vault: PublicKey;
  assets: BN;
  minSharesOut: BN;
}

/**
 * Parameters for confidential withdraw
 */
export interface ConfidentialWithdrawParams {
  vault: PublicKey;
  assets: BN;
  maxSharesIn: BN;
  newDecryptableBalance: DecryptableBalance;
  equalityProofContext: PublicKey;
  rangeProofContext: PublicKey;
}

/**
 * Parameters for confidential redeem
 */
export interface ConfidentialRedeemParams {
  vault: PublicKey;
  shares: BN;
  minAssetsOut: BN;
  newDecryptableBalance: DecryptableBalance;
  equalityProofContext: PublicKey;
  rangeProofContext: PublicKey;
}

/**
 * Parameters for applying pending balance
 */
export interface ApplyPendingParams {
  vault: PublicKey;
  newDecryptableAvailableBalance: DecryptableBalance;
  expectedPendingBalanceCreditCounter: BN;
}

/**
 * Result of a confidential deposit
 */
export interface ConfidentialDepositResult {
  signature: TransactionSignature;
  sharesReceived: BN;
  assetsDeposited: BN;
}

/**
 * Result of a confidential withdraw/redeem
 */
export interface ConfidentialWithdrawResult {
  signature: TransactionSignature;
  sharesBurned: BN;
  assetsReceived: BN;
}

/**
 * Privacy Cash deposit parameters (full privacy flow)
 */
export interface PrivateDepositParams {
  assets: BN;
  minSharesOut: BN;
}

/**
 * Privacy Cash withdraw parameters (full privacy flow)
 */
export interface PrivateWithdrawParams {
  shares: BN;
  minAssetsOut: BN;
}

/**
 * Result of a private deposit (full privacy)
 */
export interface PrivateDepositResult {
  shieldTx: TransactionSignature;
  withdrawTx: TransactionSignature;
  depositTx: TransactionSignature;
  ephemeralWallet: PublicKey;
  sharesReceived: BN;
}

/**
 * Result of a private withdraw (full privacy)
 */
export interface PrivateWithdrawResult {
  redeemTx: TransactionSignature;
  shieldTx: TransactionSignature;
  withdrawTx: TransactionSignature;
  assetsReceived: BN;
}

/**
 * Vault state from SVS-2 (confidential)
 */
export interface ConfidentialVaultState {
  authority: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  assetVault: PublicKey;
  totalAssets: BN;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
  auditorElgamalPubkey: Uint8Array | null;
  confidentialAuthority: PublicKey;
}

/**
 * User's confidential shares account state
 */
export interface ConfidentialSharesAccountState {
  owner: PublicKey;
  mint: PublicKey;
  nonConfidentialBalance: BN;
  pendingBalance: EncryptedBalance;
  availableBalance: EncryptedBalance;
  decryptableAvailableBalance: DecryptableBalance;
  pendingBalanceCreditCounter: BN;
  allowConfidentialCredits: boolean;
  allowNonConfidentialCredits: boolean;
}
