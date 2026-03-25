import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/** On-chain ConfidentialStreamVault state. */
export interface VaultState {
  authority: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  assetVault: PublicKey;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
  baseAssets: BN;
  totalShares: BN;
  streamAmount: BN;
  streamStart: BN;
  streamEnd: BN;
  lastCheckpoint: BN;
  auditorElgamalPubkey: number[] | null;
  confidentialAuthority: PublicKey;
}

/** Parameters for vault initialization. */
export interface InitializeParams {
  vaultId: BN;
  assetDecimals: number;
  auditorElgamalPubkey: number[] | null;
}

/** Parameters for distribute_yield. */
export interface DistributeYieldParams {
  amount: BN;
  durationSeconds: BN;
}

/** Deposit operation preview result. */
export interface DepositPreview {
  assets: BN;
  expectedShares: BN;
  effectiveTotalAssets: BN;
  sharePrice: number;
}

/** Redeem operation preview result. */
export interface RedeemPreview {
  shares: BN;
  expectedAssets: BN;
  effectiveTotalAssets: BN;
  sharePrice: number;
}

/** Streaming yield status. */
export interface StreamStatus {
  isActive: boolean;
  baseAssets: BN;
  streamAmount: BN;
  accrued: BN;
  remaining: BN;
  effectiveTotalAssets: BN;
  streamStartTimestamp: BN;
  streamEndTimestamp: BN;
  lastCheckpointTimestamp: BN;
  percentComplete: number;
}

/** Module configuration status. */
export interface ModuleStatus {
  feeConfigExists: boolean;
  capConfigExists: boolean;
  lockConfigExists: boolean;
  accessConfigExists: boolean;
}

/** Options for which modules to include in transactions. */
export interface ModuleOptions {
  includeFees?: boolean;
  includeCaps?: boolean;
  includeLocks?: boolean;
  includeAccess?: boolean;
  includeRewards?: { rewardMint: PublicKey };
}
