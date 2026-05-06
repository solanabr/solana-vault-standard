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
export * from "./streaming-vault";
export * from "./credit-vault";
export * from "./credit-vault-pda";
export * from "./pda";
export * from "./math";

// SVS-7 Native SOL Vault
export * from "./svs-7";
// SVS-9 Allocator Vault
export * from "./svs9";
// Tranched Vault (SVS-12)
export * from "./tranched-vault";
export * from "./tranched-vault-pda";

// On-chain Module Support (v2)
export * from "./modules";

// Supporting programs (Token-2022 TransferHook, NAV oracle, deRWA wrapper)
export * from "./compliance-hook";
export * from "./compliance-hook-pda";
export * from "./nav-oracle";
export * from "./nav-oracle-pda";
export * from "./derwa-wrapper";
export * from "./derwa-wrapper-pda";
export * from "./mock-sas-pda";

// SDK Modules (client-side, deprecated for enforcement - use on-chain modules)
export * from "./fees";
export * from "./cap";
export * from "./emergency";
export * from "./access-control";
export * from "./multi-asset";
export * from "./timelock";
export * from "./strategy";

export * from "./async-vault";
export {
  ASYNC_VAULT_SEED,
  ASYNC_SHARES_MINT_SEED,
  SHARE_ESCROW_SEED,
  DEPOSIT_REQUEST_SEED,
  REDEEM_REQUEST_SEED,
  CLAIMABLE_TOKENS_SEED as ASYNC_CLAIMABLE_TOKENS_SEED,
  OPERATOR_APPROVAL_SEED,
  getAsyncVaultAddress,
  getAsyncSharesMintAddress,
  getShareEscrowAddress,
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableTokensAddress as getAsyncClaimableTokensAddress,
  getOperatorApprovalAddress,
  deriveAsyncVaultAddresses,
} from "./async-vault-pda";

// Re-export common types
export { BN } from "@coral-xyz/anchor";
export { PublicKey } from "@solana/web3.js";

export {
  MULTI_VAULT_SEED,
  ASSET_ENTRY_SEED,
  SHARES_SEED,
  ORACLE_PRICE_SEED,
  PRICE_SCALE,
  getBasketVaultAddress,
  getBasketSharesMintAddress,
  getAssetEntryAddress,
  getOraclePriceAddress,
  InitializeParams as Svs8InitializeParams,
  AddAssetParams,
  UpdateOracleParams,
  DepositSingleParams,
  DepositProportionalParams,
  RedeemProportionalParams,
  BasketVaultState,
  AssetEntryState,
  OraclePriceState,
  BasketVault,
} from "./svs-8";
