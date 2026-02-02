/**
 * SVS Privacy SDK
 *
 * Privacy-enabled SDK for SVS-2 Confidential Vaults with Token-2022
 * Confidential Transfers and optional Privacy Cash integration.
 *
 * ## Privacy Levels
 *
 * | Level | What's Hidden | SDK Class |
 * |-------|---------------|-----------|
 * | None (SVS-1) | Nothing | SolanaVault |
 * | Amount (SVS-2) | Share balances | ConfidentialSolanaVault |
 * | Full (SVS-2 + Privacy Cash) | Amounts + addresses | PrivacySolanaVault |
 *
 * ## Current Status (January 2026)
 *
 * - ZK ElGamal Program: Available (patched after June 2025 audit)
 * - Rust SDK: Full support via solana-zk-sdk
 * - JavaScript WASM: Expected mid-2026
 * - Rust Backend Proxy: Available for JS proof generation
 *
 * This SDK provides:
 * - Proper key derivation matching the Token-2022 standard
 * - AES encryption/decryption using Web Crypto API
 * - Proof data structures ready for WASM bindings
 * - Rust backend integration for real ZK proof generation
 * - WASM bridge interface for when bindings are available
 *
 * For production use:
 * - Use the Rust proof backend (`configureProofBackend()`)
 * - Or use Wallets-as-a-Service providers
 *
 * @see https://solana.com/docs/tokens/extensions/confidential-transfer
 * @module @stbr/svs-privacy-sdk
 */

// Types and constants
export * from "./types";

// Encryption utilities
export {
  deriveElGamalKeypair,
  deriveAesKey,
  createDecryptableZeroBalance,
  createDecryptableBalance,
  decryptBalance,
  computeNewDecryptableBalance,
  elgamalPubkeyToBytes,
  decryptableBalanceToBytes,
  // Async Web Crypto API versions
  encryptAesGcmAsync,
  decryptAesGcmAsync,
} from "./encryption";

// ZK Proof utilities
export {
  ZK_ELGAMAL_PROOF_PROGRAM_ID,
  PROOF_DATA_SIZES,
  // Local proof generation (placeholder - requires WASM)
  createPubkeyValidityProofData,
  createEqualityProofData,
  createRangeProofData,
  // Context account management
  createProofContextAccount,
  createVerifyPubkeyValidityInstruction,
  createVerifyEqualityProofInstruction,
  createVerifyRangeProofInstruction,
  closeProofContextAccount,
  // Backend proof generation (real ZK proofs via Rust)
  configureProofBackend,
  createPubkeyValidityProofViaBackend,
  createEqualityProofViaBackend,
  createRangeProofViaBackend,
  isProofBackendAvailable,
} from "./proofs";

// WASM bridge (for future SDK bindings)
export {
  isWasmLoaded,
  initWasm,
  isWasmProofGenerationAvailable,
  // WASM-backed implementations (will work when bindings are available)
  deriveElGamalKeypairWasm,
  deriveAesKeyWasm,
  createPubkeyValidityProofWasm,
} from "./wasm-bridge";

// Confidential Vault (SVS-2 wrapper)
export {
  SVS_2_PROGRAM_ID,
  ConfidentialSolanaVault,
} from "./confidential-vault";

// Privacy Cash integration
export {
  PRIVACY_CASH_PROGRAM_ID,
  PrivacyCashClient,
  createPrivateDepositFlow,
  completePrivateDeposit,
  type ShieldParams,
  type UnshieldParams,
  type ShieldedNote,
} from "./privacy-cash";

// Full Privacy Vault (SVS-2 + Privacy Cash)
export { PrivacySolanaVault } from "./private-vault";

// Confidential Transfer Instructions (Token-2022)
export {
  createConfigureAccountInstruction,
  createApplyPendingBalanceInstruction,
  createConfidentialDepositInstruction,
  createConfidentialWithdrawInstruction,
  createEnableConfidentialCreditsInstruction,
  createEnableNonConfidentialCreditsInstruction,
} from "./confidential-instructions";
