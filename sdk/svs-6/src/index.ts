// SVS-6 Confidential Streaming Yield Vault SDK
// ──────────────────────────────────────────────

export { ConfidentialStreamingVault } from "./vault";

export {
  deriveVaultAddress,
  deriveSharesMintAddress,
  deriveModuleAddresses,
  deriveUserModuleAddresses,
  deriveRewardModuleAddresses,
  VAULT_SEED,
  SHARES_MINT_SEED,
} from "./pda";

export {
  effectiveTotalAssets,
  calculateAccrued,
  convertToShares,
  convertToAssets,
  convertToSharesCeil,
  convertToAssetsCeil,
  calculateOffset,
  sharePrice,
} from "./math";

export type {
  VaultState,
  InitializeParams,
  DistributeYieldParams,
  DepositPreview,
  RedeemPreview,
  StreamStatus,
  ModuleStatus,
  ModuleOptions,
} from "./types";
