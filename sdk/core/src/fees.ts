/**
 * Vault Fee Module
 *
 * Fee calculation utilities for SVS vaults. Supports:
 * - Management fees: Time-based annual fee on AUM
 * - Performance fees: Fee on profits above high-water mark
 * - Entry/exit fees: Optional deposit/withdrawal fees
 *
 * All fees are specified in basis points (bps), where 10000 bps = 100%.
 *
 * @example
 * ```ts
 * import { calculateManagementFee, calculatePerformanceFee } from "./fees";
 *
 * // Calculate management fee for 30 days
 * const mgmtFee = calculateManagementFee(totalAssets, 200, 30 * 86400);
 *
 * // Calculate performance fee with HWM
 * const perfFee = calculatePerformanceFee(profit, highWaterMark, 2000);
 * ```
 */

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { convertToShares, Rounding } from "./math";

const BPS_DENOMINATOR = 10000;
const SECONDS_PER_YEAR = 31536000;

/**
 * Fee configuration for a vault
 */
export interface FeeConfig {
  /** Annual management fee in basis points (e.g., 200 = 2%) */
  managementFeeBps: number;
  /** Performance fee in basis points (e.g., 2000 = 20%) */
  performanceFeeBps: number;
  /** Optional entry fee in basis points */
  entryFeeBps?: number;
  /** Optional exit fee in basis points */
  exitFeeBps?: number;
  /** Recipient of collected fees */
  feeRecipient: PublicKey;
}

/**
 * Fee state tracking for time-based and HWM calculations
 */
export interface FeeState {
  /** Unix timestamp of last fee accrual */
  lastFeeTimestamp: number;
  /** High water mark for performance fee (share price * 1e9) */
  highWaterMark: BN;
  /** Accumulated uncollected management fees */
  accruedManagementFee: BN;
  /** Accumulated uncollected performance fees */
  accruedPerformanceFee: BN;
}

/**
 * Result of fee calculation
 */
export interface FeeCalculationResult {
  /** Management fee amount in assets */
  managementFee: BN;
  /** Performance fee amount in assets */
  performanceFee: BN;
  /** Combined fee amount */
  totalFee: BN;
  /** Assets remaining after fees */
  netAssets: BN;
  /** Updated high water mark */
  newHighWaterMark: BN;
}

/**
 * Result of applying entry fee to a deposit
 */
export interface DepositWithFeesResult {
  /** Shares before entry fee deduction */
  grossShares: BN;
  /** Entry fee in shares */
  entryFee: BN;
  /** Shares user receives after fee */
  netShares: BN;
}

/**
 * Result of applying exit fee to a withdrawal
 */
export interface WithdrawWithFeesResult {
  /** Assets before exit fee deduction */
  grossAssets: BN;
  /** Exit fee in assets */
  exitFee: BN;
  /** Assets user receives after fee */
  netAssets: BN;
}

/**
 * Calculate management fee for a time period.
 * Management fee is charged as a percentage of AUM pro-rated over time.
 *
 * Formula: totalAssets * feeBps * secondsElapsed / (BPS_DENOMINATOR * SECONDS_PER_YEAR)
 */
export function calculateManagementFee(
  totalAssets: BN,
  feeBps: number,
  secondsElapsed: number,
): BN {
  if (feeBps === 0 || secondsElapsed === 0 || totalAssets.isZero()) {
    return new BN(0);
  }

  // fee = totalAssets * feeBps * secondsElapsed / (10000 * 31536000)
  return totalAssets
    .mul(new BN(feeBps))
    .mul(new BN(secondsElapsed))
    .div(new BN(BPS_DENOMINATOR))
    .div(new BN(SECONDS_PER_YEAR));
}

/**
 * Calculate performance fee based on high water mark.
 * Performance fee is only charged when share price exceeds previous high.
 *
 * @param currentSharePrice Current share price (scaled by 1e9)
 * @param highWaterMark Previous high water mark (scaled by 1e9)
 * @param totalShares Total shares outstanding
 * @param feeBps Performance fee in basis points
 * @returns Fee amount and new high water mark
 */
export function calculatePerformanceFee(
  currentSharePrice: BN,
  highWaterMark: BN,
  totalShares: BN,
  feeBps: number,
): { fee: BN; newHighWaterMark: BN } {
  if (
    feeBps === 0 ||
    totalShares.isZero() ||
    currentSharePrice.lte(highWaterMark)
  ) {
    return { fee: new BN(0), newHighWaterMark: highWaterMark };
  }

  // profit per share = currentPrice - hwm
  const profitPerShare = currentSharePrice.sub(highWaterMark);

  // total profit = profitPerShare * totalShares / 1e9 (unscale)
  const totalProfit = profitPerShare.mul(totalShares).div(new BN(1e9));

  // fee = totalProfit * feeBps / 10000
  const fee = totalProfit.mul(new BN(feeBps)).div(new BN(BPS_DENOMINATOR));

  return {
    fee,
    newHighWaterMark: currentSharePrice,
  };
}

/**
 * Calculate all accrued fees for a vault.
 */
export function calculateAccruedFees(
  totalAssets: BN,
  totalShares: BN,
  feeConfig: FeeConfig,
  feeState: FeeState,
  currentTimestamp: number,
): FeeCalculationResult {
  const secondsElapsed = Math.max(
    0,
    currentTimestamp - feeState.lastFeeTimestamp,
  );

  // Management fee
  const managementFee = calculateManagementFee(
    totalAssets,
    feeConfig.managementFeeBps,
    secondsElapsed,
  );

  // Calculate current share price (scaled by 1e9)
  let currentSharePrice = new BN(1e9);
  if (!totalShares.isZero()) {
    currentSharePrice = totalAssets.mul(new BN(1e9)).div(totalShares);
  }

  // Performance fee
  const { fee: performanceFee, newHighWaterMark } = calculatePerformanceFee(
    currentSharePrice,
    feeState.highWaterMark,
    totalShares,
    feeConfig.performanceFeeBps,
  );

  const totalFee = managementFee.add(performanceFee);
  const netAssets = totalAssets.sub(totalFee);

  return {
    managementFee,
    performanceFee,
    totalFee,
    netAssets: netAssets.isNeg() ? new BN(0) : netAssets,
    newHighWaterMark,
  };
}

/**
 * Apply entry fee to shares received from a deposit.
 */
export function applyEntryFee(
  grossShares: BN,
  entryFeeBps: number,
): DepositWithFeesResult {
  if (entryFeeBps === 0 || grossShares.isZero()) {
    return {
      grossShares,
      entryFee: new BN(0),
      netShares: grossShares,
    };
  }

  // fee = grossShares * feeBps / 10000
  const entryFee = grossShares
    .mul(new BN(entryFeeBps))
    .div(new BN(BPS_DENOMINATOR));
  const netShares = grossShares.sub(entryFee);

  return {
    grossShares,
    entryFee,
    netShares,
  };
}

/**
 * Apply exit fee to assets received from a withdrawal.
 */
export function applyExitFee(
  grossAssets: BN,
  exitFeeBps: number,
): WithdrawWithFeesResult {
  if (exitFeeBps === 0 || grossAssets.isZero()) {
    return {
      grossAssets,
      exitFee: new BN(0),
      netAssets: grossAssets,
    };
  }

  // fee = grossAssets * feeBps / 10000
  const exitFee = grossAssets
    .mul(new BN(exitFeeBps))
    .div(new BN(BPS_DENOMINATOR));
  const netAssets = grossAssets.sub(exitFee);

  return {
    grossAssets,
    exitFee,
    netAssets,
  };
}

/**
 * Convert a fee amount (in assets) to shares for minting to fee recipient.
 */
export function feeToShares(
  feeAssets: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
): BN {
  if (feeAssets.isZero()) {
    return new BN(0);
  }

  return convertToShares(
    feeAssets,
    totalAssets,
    totalShares,
    decimalsOffset,
    Rounding.Floor,
  );
}

/**
 * Create initial fee state with high water mark at 1:1.
 */
export function createInitialFeeState(timestamp: number): FeeState {
  return {
    lastFeeTimestamp: timestamp,
    highWaterMark: new BN(1e9), // 1.0 scaled
    accruedManagementFee: new BN(0),
    accruedPerformanceFee: new BN(0),
  };
}

/**
 * Update fee state after collecting fees.
 */
export function updateFeeState(
  state: FeeState,
  result: FeeCalculationResult,
  currentTimestamp: number,
): FeeState {
  return {
    lastFeeTimestamp: currentTimestamp,
    highWaterMark: result.newHighWaterMark,
    accruedManagementFee: new BN(0),
    accruedPerformanceFee: new BN(0),
  };
}

/**
 * Validate fee configuration.
 */
export function validateFeeConfig(config: FeeConfig): boolean {
  if (
    config.managementFeeBps < 0 ||
    config.managementFeeBps > BPS_DENOMINATOR
  ) {
    return false;
  }
  if (
    config.performanceFeeBps < 0 ||
    config.performanceFeeBps > BPS_DENOMINATOR
  ) {
    return false;
  }
  if (
    config.entryFeeBps !== undefined &&
    (config.entryFeeBps < 0 || config.entryFeeBps > BPS_DENOMINATOR)
  ) {
    return false;
  }
  if (
    config.exitFeeBps !== undefined &&
    (config.exitFeeBps < 0 || config.exitFeeBps > BPS_DENOMINATOR)
  ) {
    return false;
  }
  return true;
}
