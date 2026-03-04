/**
 * Multi-Asset Vault Module
 *
 * Portfolio management across multiple SVS vaults. Enables:
 * - Target allocation weights per vault
 * - Automatic rebalancing detection
 * - Rebalance operation calculation
 *
 * Weights are specified in basis points (bps), totaling 10000 (100%).
 *
 * @example
 * ```ts
 * import { calculateRebalance, getMultiVaultState } from "./multi-asset";
 *
 * // Define portfolio allocation
 * const config: MultiVaultConfig = {
 *   allocations: [
 *     { vault: vaultA, targetWeight: 6000 }, // 60%
 *     { vault: vaultB, targetWeight: 4000 }, // 40%
 *   ],
 *   rebalanceThresholdBps: 500, // 5% deviation triggers rebalance
 *   maxSlippageBps: 100,
 * };
 *
 * // Check if rebalancing is needed
 * const state = await getMultiVaultState(config, connection);
 * if (state.needsRebalance) {
 *   console.log(`${state.rebalanceOperations.length} ops needed`);
 * }
 * ```
 */

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

const BPS_DENOMINATOR = 10000;

/**
 * Vault allocation in a multi-asset portfolio
 */
export interface VaultAllocation {
  /** Vault public key */
  vault: PublicKey;
  /** Target weight in basis points (e.g., 5000 = 50%) */
  targetWeight: number;
  /** Current actual weight (calculated) */
  currentWeight?: number;
  /** Current value in the vault */
  currentValue?: BN;
}

/**
 * Multi-asset vault configuration
 */
export interface MultiVaultConfig {
  /** Vault allocations */
  allocations: VaultAllocation[];
  /** Rebalance when weight deviates by this amount (bps) */
  rebalanceThresholdBps: number;
  /** Maximum slippage for rebalance operations (bps) */
  maxSlippageBps: number;
}

/**
 * Multi-asset vault state
 */
export interface MultiVaultState {
  /** Total value across all vaults */
  totalValue: BN;
  /** Current allocations with weights */
  allocations: VaultAllocation[];
  /** Whether rebalancing is needed */
  needsRebalance: boolean;
  /** Operations needed to rebalance */
  rebalanceOperations: RebalanceOp[];
}

/**
 * A single rebalance operation
 */
export interface RebalanceOp {
  /** Source vault */
  fromVault: PublicKey;
  /** Destination vault */
  toVault: PublicKey;
  /** Amount to transfer */
  amount: BN;
}

/**
 * Result of a multi-vault deposit
 */
export interface MultiDepositResult {
  /** Individual deposits per vault */
  deposits: VaultDepositResult[];
  /** Total assets deposited */
  totalAssetsDeposited: BN;
}

/**
 * Individual vault deposit in a multi-deposit
 */
export interface VaultDepositResult {
  /** Vault that received deposit */
  vault: PublicKey;
  /** Assets deposited */
  assets: BN;
  /** Shares received */
  shares: BN;
}

/**
 * Result of a multi-vault redemption
 */
export interface MultiRedeemResult {
  /** Individual redemptions per vault */
  redemptions: VaultRedeemResult[];
  /** Total assets received */
  totalAssetsReceived: BN;
}

/**
 * Individual vault redemption in a multi-redeem
 */
export interface VaultRedeemResult {
  /** Vault from which shares were redeemed */
  vault: PublicKey;
  /** Shares redeemed */
  shares: BN;
  /** Assets received */
  assets: BN;
}

/**
 * Validate that weights sum to 100% (10000 bps).
 */
export function validateWeights(allocations: VaultAllocation[]): boolean {
  if (allocations.length === 0) {
    return false;
  }

  const totalWeight = allocations.reduce((sum, a) => sum + a.targetWeight, 0);

  return totalWeight === BPS_DENOMINATOR;
}

/**
 * Allocate a deposit across vaults based on target weights.
 */
export function allocateDeposit(
  totalDeposit: BN,
  allocations: VaultAllocation[],
): Map<string, BN> {
  const result = new Map<string, BN>();

  if (totalDeposit.isZero() || allocations.length === 0) {
    return result;
  }

  let remaining = totalDeposit.clone();
  let remainingWeight = BPS_DENOMINATOR;

  // Allocate to each vault
  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    const key = alloc.vault.toBase58();

    if (i === allocations.length - 1) {
      // Last allocation gets remainder to avoid rounding errors
      result.set(key, remaining);
    } else {
      // Calculate proportional amount
      const amount = totalDeposit
        .mul(new BN(alloc.targetWeight))
        .div(new BN(BPS_DENOMINATOR));

      result.set(key, amount);
      remaining = remaining.sub(amount);
      remainingWeight -= alloc.targetWeight;
    }
  }

  return result;
}

/**
 * Calculate current weights based on vault values.
 */
export function calculateCurrentWeights(
  allocations: VaultAllocation[],
  vaultValues: Map<string, BN>,
): VaultAllocation[] {
  // Calculate total value
  let totalValue = new BN(0);
  for (const alloc of allocations) {
    const value = vaultValues.get(alloc.vault.toBase58()) ?? new BN(0);
    totalValue = totalValue.add(value);
  }

  // Calculate weights
  return allocations.map((alloc) => {
    const value = vaultValues.get(alloc.vault.toBase58()) ?? new BN(0);
    let currentWeight = 0;

    if (!totalValue.isZero()) {
      currentWeight = value
        .mul(new BN(BPS_DENOMINATOR))
        .div(totalValue)
        .toNumber();
    }

    return {
      ...alloc,
      currentWeight,
      currentValue: value,
    };
  });
}

/**
 * Determine if rebalancing is needed.
 */
export function needsRebalance(
  allocations: VaultAllocation[],
  thresholdBps: number,
): boolean {
  for (const alloc of allocations) {
    if (alloc.currentWeight === undefined) {
      continue;
    }

    const deviation = Math.abs(alloc.targetWeight - alloc.currentWeight);
    if (deviation > thresholdBps) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate rebalance operations to bring allocations back to target.
 */
export function calculateRebalanceOps(
  allocations: VaultAllocation[],
  vaultValues: Map<string, BN>,
): RebalanceOp[] {
  const ops: RebalanceOp[] = [];

  // Calculate total value
  let totalValue = new BN(0);
  for (const value of vaultValues.values()) {
    totalValue = totalValue.add(value);
  }

  if (totalValue.isZero()) {
    return ops;
  }

  // Calculate deltas (positive = overweight, negative = underweight)
  const deltas: { vault: PublicKey; delta: BN }[] = [];

  for (const alloc of allocations) {
    const currentValue = vaultValues.get(alloc.vault.toBase58()) ?? new BN(0);
    const targetValue = totalValue
      .mul(new BN(alloc.targetWeight))
      .div(new BN(BPS_DENOMINATOR));

    const delta = currentValue.sub(targetValue);
    deltas.push({ vault: alloc.vault, delta });
  }

  // Sort: overweight first (positive delta), then underweight (negative delta)
  deltas.sort((a, b) => {
    if (b.delta.gt(a.delta)) return 1;
    if (b.delta.lt(a.delta)) return -1;
    return 0;
  });

  // Match overweight vaults with underweight vaults
  let overIdx = 0;
  let underIdx = deltas.length - 1;

  while (overIdx < underIdx) {
    const over = deltas[overIdx];
    const under = deltas[underIdx];

    // Skip if not actually over/under weight
    if (over.delta.lte(new BN(0))) break;
    if (under.delta.gte(new BN(0))) break;

    // Calculate transfer amount (minimum of excess and deficit)
    const amount = BN.min(over.delta, under.delta.abs());

    if (amount.gt(new BN(0))) {
      ops.push({
        fromVault: over.vault,
        toVault: under.vault,
        amount,
      });

      over.delta = over.delta.sub(amount);
      under.delta = under.delta.add(amount);
    }

    // Move indices
    if (over.delta.isZero()) overIdx++;
    if (under.delta.isZero()) underIdx--;
  }

  return ops;
}

/**
 * Allocate a redemption across vaults proportionally.
 */
export function allocateRedemption(
  totalRedemption: BN,
  allocations: VaultAllocation[],
  vaultValues: Map<string, BN>,
): Map<string, BN> {
  const result = new Map<string, BN>();

  // Calculate total value
  let totalValue = new BN(0);
  for (const alloc of allocations) {
    const value = vaultValues.get(alloc.vault.toBase58()) ?? new BN(0);
    totalValue = totalValue.add(value);
  }

  if (totalValue.isZero() || totalRedemption.isZero()) {
    return result;
  }

  let remaining = totalRedemption.clone();

  // Allocate proportionally to current values
  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    const key = alloc.vault.toBase58();
    const currentValue = vaultValues.get(key) ?? new BN(0);

    if (i === allocations.length - 1) {
      // Last gets remainder
      result.set(key, remaining);
    } else if (!currentValue.isZero()) {
      const amount = totalRedemption.mul(currentValue).div(totalValue);
      result.set(key, amount);
      remaining = remaining.sub(amount);
    } else {
      result.set(key, new BN(0));
    }
  }

  return result;
}

/**
 * Get the current state of a multi-asset vault.
 */
export function getMultiVaultState(
  config: MultiVaultConfig,
  vaultValues: Map<string, BN>,
): MultiVaultState {
  // Calculate current weights
  const allocations = calculateCurrentWeights(config.allocations, vaultValues);

  // Calculate total value
  let totalValue = new BN(0);
  for (const value of vaultValues.values()) {
    totalValue = totalValue.add(value);
  }

  // Check if rebalance needed
  const rebalanceNeeded = needsRebalance(
    allocations,
    config.rebalanceThresholdBps,
  );

  // Calculate rebalance ops
  const rebalanceOperations = rebalanceNeeded
    ? calculateRebalanceOps(allocations, vaultValues)
    : [];

  return {
    totalValue,
    allocations,
    needsRebalance: rebalanceNeeded,
    rebalanceOperations,
  };
}

/**
 * Create a multi-vault configuration.
 */
export function createMultiVaultConfig(
  allocations: { vault: PublicKey; weight: number }[],
  options?: {
    rebalanceThresholdBps?: number;
    maxSlippageBps?: number;
  },
): MultiVaultConfig {
  return {
    allocations: allocations.map((a) => ({
      vault: a.vault,
      targetWeight: a.weight,
    })),
    rebalanceThresholdBps: options?.rebalanceThresholdBps ?? 500, // 5% default
    maxSlippageBps: options?.maxSlippageBps ?? 100, // 1% default
  };
}

/**
 * Validate multi-vault configuration.
 */
export function validateMultiVaultConfig(config: MultiVaultConfig): boolean {
  if (config.allocations.length === 0) {
    return false;
  }

  if (!validateWeights(config.allocations)) {
    return false;
  }

  if (
    config.rebalanceThresholdBps < 0 ||
    config.rebalanceThresholdBps > BPS_DENOMINATOR
  ) {
    return false;
  }

  if (config.maxSlippageBps < 0 || config.maxSlippageBps > BPS_DENOMINATOR) {
    return false;
  }

  // Check for duplicate vaults
  const seen = new Set<string>();
  for (const alloc of config.allocations) {
    const key = alloc.vault.toBase58();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }

  // Check for valid weights
  for (const alloc of config.allocations) {
    if (alloc.targetWeight < 0 || alloc.targetWeight > BPS_DENOMINATOR) {
      return false;
    }
  }

  return true;
}

/**
 * Calculate the effective share of a portfolio for a given amount of "meta-shares".
 * This is useful for tracking ownership in the multi-vault.
 */
export function calculatePortfolioShare(
  metaShares: BN,
  totalMetaShares: BN,
  portfolioValue: BN,
): BN {
  if (totalMetaShares.isZero()) {
    return new BN(0);
  }

  return metaShares.mul(portfolioValue).div(totalMetaShares);
}
