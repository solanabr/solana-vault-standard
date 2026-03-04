/**
 * Solana Vault Standard (SVS) SDK
 *
 * Native port of ERC-4626 to Solana. Provides a standardized interface
 * for tokenized vaults with shares representing proportional ownership
 * of underlying SPL tokens.
 *
 * Vault Variants:
 * - SVS-1: Public vault with live balance (reads asset_vault.amount)
 * - SVS-2: Managed vault with stored balance (uses vault.total_assets)
 * - SVS-3: Confidential vault with Token-2022 confidential transfers
 * - SVS-4: Privacy-preserving vault with ZK proofs
 *
 * @example
 * ```ts
 * import { SolanaVault, ManagedVault, previewDeposit } from "@stbr/solana-vault";
 *
 * // Load SVS-1 vault
 * const vault = await SolanaVault.load(program, assetMint, 1);
 *
 * // Preview deposit
 * const shares = await vault.previewDeposit(new BN(1_000_000));
 *
 * // Deposit with slippage protection
 * await vault.deposit(user, {
 *   assets: new BN(1_000_000),
 *   minSharesOut: shares.mul(new BN(95)).div(new BN(100)),
 * });
 * ```
 *
 * @packageDocumentation
 */

export * from "./vault";
export * from "./managed-vault";
export * from "./pda";
export * from "./math";

// SDK Modules
export * from "./fees";
export * from "./cap";
export * from "./emergency";
export * from "./access-control";
export * from "./multi-asset";
export * from "./timelock";
export * from "./strategy";

// Re-export common types
export { BN } from "@coral-xyz/anchor";
export { PublicKey } from "@solana/web3.js";
