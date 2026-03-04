/**
 * Emergency Withdrawal Module
 *
 * Emergency exit functionality for paused vaults. Allows users to
 * withdraw with a penalty when normal operations are suspended.
 *
 * Features:
 * - Configurable penalty rate in basis points
 * - Min/max penalty bounds
 * - Per-user cooldown between withdrawals
 * - Penalty funds routed to configurable recipient
 *
 * @example
 * ```ts
 * import { calculateEmergencyWithdraw, checkEmergencyAllowed } from "./emergency";
 *
 * // Check if user can emergency withdraw
 * const check = checkEmergencyAllowed(status, userLastWithdraw, now);
 * if (!check.allowed) {
 *   console.log(`Wait ${check.waitTime}s before withdrawing`);
 * }
 *
 * // Calculate withdrawal with penalty
 * const result = calculateEmergencyWithdraw(shares, config, vaultState);
 * console.log(`Receive ${result.netAssets} after ${result.penalty} penalty`);
 * ```
 */

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { convertToAssets, Rounding } from "./math";

const BPS_DENOMINATOR = 10000;

/**
 * Emergency withdrawal configuration
 */
export interface EmergencyConfig {
  /** Penalty percentage in basis points (e.g., 500 = 5%) */
  penaltyBps: number;
  /** Minimum penalty amount in assets */
  minPenalty: BN;
  /** Maximum penalty amount in assets (cap) */
  maxPenalty: BN;
  /** Cooldown period in seconds between emergency withdrawals */
  cooldownPeriod: number;
  /** Recipient of penalty funds */
  penaltyRecipient: PublicKey;
}

/**
 * Result of an emergency withdrawal calculation
 */
export interface EmergencyWithdrawResult {
  /** Assets before penalty deduction */
  grossAssets: BN;
  /** Penalty amount deducted */
  penalty: BN;
  /** Assets user receives after penalty */
  netAssets: BN;
  /** Shares that will be burned */
  sharesBurned: BN;
}

/**
 * Current emergency withdrawal status
 */
export interface EmergencyStatus {
  /** Whether emergency withdrawals are enabled (vault is paused) */
  isEmergencyEnabled: boolean;
  /** Seconds until user can emergency withdraw again */
  userCooldownRemaining: number;
  /** Estimated penalty for full share redemption */
  estimatedPenalty: BN;
}

/**
 * Result of checking if emergency withdrawal is allowed
 */
export interface EmergencyCheckResult {
  /** Whether emergency withdrawal is allowed */
  allowed: boolean;
  /** Seconds to wait if not allowed due to cooldown */
  waitTime: number;
  /** Reason if not allowed */
  reason?: EmergencyDenialReason;
}

/**
 * Reason for denying emergency withdrawal
 */
export enum EmergencyDenialReason {
  VaultNotPaused = "VAULT_NOT_PAUSED",
  CooldownActive = "COOLDOWN_ACTIVE",
  InsufficientShares = "INSUFFICIENT_SHARES",
}

/**
 * Calculate emergency withdrawal penalty.
 * Penalty is clamped between min and max values.
 */
export function calculateEmergencyPenalty(
  assets: BN,
  config: EmergencyConfig,
): BN {
  if (assets.isZero() || config.penaltyBps === 0) {
    return new BN(0);
  }

  // Calculate percentage-based penalty
  let penalty = assets
    .mul(new BN(config.penaltyBps))
    .div(new BN(BPS_DENOMINATOR));

  // Apply minimum penalty
  if (penalty.lt(config.minPenalty)) {
    penalty = config.minPenalty;
  }

  // Apply maximum penalty cap
  if (penalty.gt(config.maxPenalty)) {
    penalty = config.maxPenalty;
  }

  // Penalty cannot exceed assets
  if (penalty.gt(assets)) {
    penalty = assets;
  }

  return penalty;
}

/**
 * Preview emergency withdrawal for given shares.
 * Returns gross assets, penalty, and net assets.
 */
export function previewEmergencyRedeem(
  shares: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
  config: EmergencyConfig,
): EmergencyWithdrawResult {
  if (shares.isZero()) {
    return {
      grossAssets: new BN(0),
      penalty: new BN(0),
      netAssets: new BN(0),
      sharesBurned: new BN(0),
    };
  }

  // Calculate gross assets (using floor rounding like normal redeem)
  const grossAssets = convertToAssets(
    shares,
    totalAssets,
    totalShares,
    decimalsOffset,
    Rounding.Floor,
  );

  // Calculate penalty
  const penalty = calculateEmergencyPenalty(grossAssets, config);

  // Net assets after penalty
  const netAssets = grossAssets.sub(penalty);

  return {
    grossAssets,
    penalty,
    netAssets: netAssets.isNeg() ? new BN(0) : netAssets,
    sharesBurned: shares,
  };
}

/**
 * Preview emergency withdrawal for exact asset amount.
 * Calculates required shares and penalty.
 */
export function previewEmergencyWithdraw(
  assetsWanted: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
  config: EmergencyConfig,
): EmergencyWithdrawResult {
  if (assetsWanted.isZero()) {
    return {
      grossAssets: new BN(0),
      penalty: new BN(0),
      netAssets: new BN(0),
      sharesBurned: new BN(0),
    };
  }

  // To get assetsWanted after penalty, need to calculate gross
  // netAssets = grossAssets - penalty
  // netAssets = grossAssets - (grossAssets * penaltyBps / 10000)
  // netAssets = grossAssets * (10000 - penaltyBps) / 10000
  // grossAssets = netAssets * 10000 / (10000 - penaltyBps)

  const effectiveRate = BPS_DENOMINATOR - config.penaltyBps;
  let grossAssets: BN;

  if (effectiveRate <= 0) {
    // 100% penalty means no assets can be withdrawn
    return {
      grossAssets: new BN(0),
      penalty: new BN(0),
      netAssets: new BN(0),
      sharesBurned: new BN(0),
    };
  }

  grossAssets = assetsWanted
    .mul(new BN(BPS_DENOMINATOR))
    .div(new BN(effectiveRate));

  // Add 1 for ceiling effect
  grossAssets = grossAssets.add(new BN(1));

  // Calculate actual penalty
  const penalty = calculateEmergencyPenalty(grossAssets, config);
  const actualNet = grossAssets.sub(penalty);

  // Calculate shares needed (ceiling rounding)
  const virtualOffset = new BN(10).pow(new BN(decimalsOffset));
  const virtualShares = totalShares.add(virtualOffset);
  const virtualAssets = totalAssets.add(new BN(1));

  const sharesBurned = grossAssets
    .mul(virtualShares)
    .add(virtualAssets.sub(new BN(1)))
    .div(virtualAssets);

  return {
    grossAssets,
    penalty,
    netAssets: actualNet.isNeg() ? new BN(0) : actualNet,
    sharesBurned,
  };
}

/**
 * Check if user can perform emergency withdrawal.
 */
export function canEmergencyWithdraw(
  vaultPaused: boolean,
  lastWithdrawTimestamp: number,
  currentTimestamp: number,
  cooldownPeriod: number,
): EmergencyCheckResult {
  if (!vaultPaused) {
    return {
      allowed: false,
      waitTime: 0,
      reason: EmergencyDenialReason.VaultNotPaused,
    };
  }

  // If never withdrawn (timestamp 0), allow immediately
  if (lastWithdrawTimestamp === 0) {
    return {
      allowed: true,
      waitTime: 0,
    };
  }

  const timeSinceLastWithdraw = currentTimestamp - lastWithdrawTimestamp;
  const waitTime = Math.max(0, cooldownPeriod - timeSinceLastWithdraw);

  if (waitTime > 0) {
    return {
      allowed: false,
      waitTime,
      reason: EmergencyDenialReason.CooldownActive,
    };
  }

  return {
    allowed: true,
    waitTime: 0,
  };
}

/**
 * Get emergency withdrawal status for a user.
 */
export function getEmergencyStatus(
  vaultPaused: boolean,
  userShares: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
  lastWithdrawTimestamp: number,
  currentTimestamp: number,
  config: EmergencyConfig,
): EmergencyStatus {
  const cooldownRemaining = Math.max(
    0,
    config.cooldownPeriod - (currentTimestamp - lastWithdrawTimestamp),
  );

  // Calculate estimated penalty for full redemption
  const fullRedeem = previewEmergencyRedeem(
    userShares,
    totalAssets,
    totalShares,
    decimalsOffset,
    config,
  );

  return {
    isEmergencyEnabled: vaultPaused,
    userCooldownRemaining: cooldownRemaining,
    estimatedPenalty: fullRedeem.penalty,
  };
}

/**
 * Create default emergency configuration.
 */
export function createEmergencyConfig(
  penaltyBps: number,
  penaltyRecipient: PublicKey,
  options?: {
    minPenalty?: BN;
    maxPenalty?: BN;
    cooldownPeriod?: number;
  },
): EmergencyConfig {
  return {
    penaltyBps,
    minPenalty: options?.minPenalty ?? new BN(0),
    maxPenalty: options?.maxPenalty ?? new BN("18446744073709551615"),
    cooldownPeriod: options?.cooldownPeriod ?? 0,
    penaltyRecipient,
  };
}

/**
 * Validate emergency configuration.
 */
export function validateEmergencyConfig(config: EmergencyConfig): boolean {
  if (config.penaltyBps < 0 || config.penaltyBps > BPS_DENOMINATOR) {
    return false;
  }
  if (config.minPenalty.isNeg()) {
    return false;
  }
  if (config.maxPenalty.isNeg() || config.maxPenalty.lt(config.minPenalty)) {
    return false;
  }
  if (config.cooldownPeriod < 0) {
    return false;
  }
  return true;
}
