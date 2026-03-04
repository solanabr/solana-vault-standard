/**
 * Strategy Module
 *
 * DeFi strategy integration for SVS vaults. Defines interfaces for:
 * - Lending protocols (Solend, Kamino)
 * - Liquid staking (Marinade, Lido)
 * - AMM liquidity provision (Orca, Raydium)
 * - Perpetual vaults (Drift)
 *
 * Strategies are managed by vault operators and can be:
 * - Active: Accepting allocations
 * - Paused: No new allocations, existing positions held
 * - Deprecated: Should not be used
 * - WindingDown: Withdrawing positions
 *
 * @example
 * ```ts
 * import { StrategyType, StrategyStatus, StrategyConfig } from "./strategy";
 *
 * const lendingStrategy: StrategyConfig = {
 *   id: "solend-usdc",
 *   type: StrategyType.Lending,
 *   programId: SOLEND_PROGRAM_ID,
 *   name: "Solend USDC Pool",
 *   status: StrategyStatus.Active,
 *   maxAllocationBps: 5000, // Max 50% of vault
 *   expectedApyBps: 800,    // ~8% APY
 *   riskScore: 3,
 * };
 * ```
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

/**
 * Strategy type identifiers
 */
export enum StrategyType {
  /** Deposit to lending protocol (Solend, Kamino, etc.) */
  Lending = "LENDING",
  /** Stake with liquid staking provider (Marinade, etc.) */
  LiquidStaking = "LIQUID_STAKING",
  /** Provide liquidity to AMM (Orca, Raydium, etc.) */
  LiquidityProvision = "LIQUIDITY_PROVISION",
  /** Deposit to perpetual vault (Drift, etc.) */
  Perpetuals = "PERPETUALS",
  /** Custom strategy */
  Custom = "CUSTOM",
}

/**
 * Strategy status
 */
export enum StrategyStatus {
  Active = "ACTIVE",
  Paused = "PAUSED",
  Deprecated = "DEPRECATED",
  WindingDown = "WINDING_DOWN",
}

/**
 * Strategy configuration
 */
export interface StrategyConfig {
  /** Strategy identifier */
  id: string;
  /** Strategy type */
  type: StrategyType;
  /** Protocol program ID */
  programId: PublicKey;
  /** Human-readable name */
  name: string;
  /** Strategy status */
  status: StrategyStatus;
  /** Maximum allocation percentage (0-10000 bps) */
  maxAllocationBps: number;
  /** Expected APY in bps (informational) */
  expectedApyBps: number;
  /** Risk score (1-10) */
  riskScore: number;
  /** Protocol-specific accounts */
  accounts: StrategyAccounts;
}

/**
 * Protocol-specific account configuration
 */
export interface StrategyAccounts {
  /** Protocol state/pool account */
  protocolState: PublicKey;
  /** User/vault position account (if applicable) */
  positionAccount?: PublicKey;
  /** Receipt token mint (cTokens, mSOL, etc.) */
  receiptMint?: PublicKey;
  /** Receipt token account */
  receiptAccount?: PublicKey;
  /** Additional accounts for CPI */
  additionalAccounts: PublicKey[];
}

/**
 * Current strategy position
 */
export interface StrategyPosition {
  /** Strategy config reference */
  strategyId: string;
  /** Assets deployed to this strategy */
  deployedAssets: BN;
  /** Receipt tokens held (if applicable) */
  receiptTokens: BN;
  /** Last sync timestamp */
  lastSyncTimestamp: number;
  /** Current estimated value in base asset */
  estimatedValue: BN;
  /** Accumulated rewards (if tracked separately) */
  accumulatedRewards: BN;
}

/**
 * Strategy allocation result
 */
export interface StrategyAllocation {
  strategyId: string;
  amount: BN;
}

/**
 * Deployment preview result
 */
export interface DeploymentPreview {
  /** Strategy ID */
  strategyId: string;
  /** Assets to deploy */
  assetsToDeply: BN;
  /** Expected receipt tokens */
  expectedReceiptTokens: BN;
  /** Estimated fee (if any) */
  estimatedFee: BN;
  /** Minimum receipt tokens (with slippage) */
  minReceiptTokens: BN;
}

/**
 * Recall preview result
 */
export interface RecallPreview {
  /** Strategy ID */
  strategyId: string;
  /** Receipt tokens to burn */
  receiptTokensToBurn: BN;
  /** Expected assets to receive */
  expectedAssets: BN;
  /** Estimated fee (if any) */
  estimatedFee: BN;
  /** Minimum assets (with slippage) */
  minAssets: BN;
}

/**
 * Harvest result
 */
export interface HarvestResult {
  /** Strategy ID */
  strategyId: string;
  /** Rewards harvested */
  rewardsHarvested: BN;
  /** Auto-compounded amount (if applicable) */
  compoundedAmount: BN;
  /** New total position value */
  newPositionValue: BN;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  /** Strategy ID */
  strategyId: string;
  /** Is healthy */
  healthy: boolean;
  /** Health score (0-100) */
  healthScore: number;
  /** Issues found */
  issues: HealthIssue[];
  /** Recommendations */
  recommendations: string[];
}

/**
 * Health issue
 */
export interface HealthIssue {
  severity: "low" | "medium" | "high" | "critical";
  code: string;
  message: string;
}

/**
 * CPI instruction builder result
 */
export interface CpiInstructionBundle {
  /** Pre-instructions (setup) */
  preInstructions: TransactionInstruction[];
  /** Main instruction */
  mainInstruction: TransactionInstruction;
  /** Post-instructions (cleanup) */
  postInstructions: TransactionInstruction[];
  /** Signers required */
  signerSeeds?: Buffer[][];
}

// ============================================================================
// Strategy Allocation Functions
// ============================================================================

/**
 * Calculate optimal allocation across multiple strategies.
 * Distributes assets based on target weights while respecting max allocations.
 */
export function calculateStrategyAllocations(
  totalAssets: BN,
  strategies: StrategyConfig[],
  targetWeights: Map<string, number>,
): StrategyAllocation[] {
  const allocations: StrategyAllocation[] = [];
  let remaining = totalAssets;
  let totalWeight = 0;

  // Validate weights sum
  for (const weight of targetWeights.values()) {
    totalWeight += weight;
  }

  // Filter active strategies
  const activeStrategies = strategies.filter(
    (s) => s.status === StrategyStatus.Active,
  );

  for (const strategy of activeStrategies) {
    const targetWeight = targetWeights.get(strategy.id) ?? 0;

    if (targetWeight === 0) continue;

    // Calculate target amount
    const targetAmount = totalAssets.muln(targetWeight).divn(totalWeight);

    // Cap at max allocation
    const maxAmount = totalAssets.muln(strategy.maxAllocationBps).divn(10000);
    const amount = BN.min(targetAmount, maxAmount);

    // Don't exceed remaining
    const finalAmount = BN.min(amount, remaining);

    if (finalAmount.gtn(0)) {
      allocations.push({
        strategyId: strategy.id,
        amount: finalAmount,
      });
      remaining = remaining.sub(finalAmount);
    }
  }

  return allocations;
}

/**
 * Preview deploying assets to a strategy.
 */
export function previewDeploy(
  assets: BN,
  strategy: StrategyConfig,
  currentExchangeRate: BN,
  slippageBps: number = 50,
): DeploymentPreview {
  // Exchange rate is scaled by 1e9
  const SCALE = new BN(1_000_000_000);

  // Calculate expected receipt tokens: assets * SCALE / exchangeRate
  const expectedReceiptTokens = assets.mul(SCALE).div(currentExchangeRate);

  // Apply slippage
  const minReceiptTokens = expectedReceiptTokens
    .muln(10000 - slippageBps)
    .divn(10000);

  // Estimate fee (protocol-specific, default 0)
  const estimatedFee = new BN(0);

  return {
    strategyId: strategy.id,
    assetsToDeply: assets,
    expectedReceiptTokens,
    estimatedFee,
    minReceiptTokens,
  };
}

/**
 * Preview recalling assets from a strategy.
 */
export function previewRecall(
  receiptTokens: BN,
  strategy: StrategyConfig,
  currentExchangeRate: BN,
  slippageBps: number = 50,
): RecallPreview {
  // Exchange rate is scaled by 1e9
  const SCALE = new BN(1_000_000_000);

  // Calculate expected assets: receiptTokens * exchangeRate / SCALE
  const expectedAssets = receiptTokens.mul(currentExchangeRate).div(SCALE);

  // Apply slippage
  const minAssets = expectedAssets.muln(10000 - slippageBps).divn(10000);

  // Estimate fee (protocol-specific, default 0)
  const estimatedFee = new BN(0);

  return {
    strategyId: strategy.id,
    receiptTokensToBurn: receiptTokens,
    expectedAssets,
    estimatedFee,
    minAssets,
  };
}

/**
 * Calculate total deployed assets across all strategies.
 */
export function getTotalDeployed(positions: StrategyPosition[]): BN {
  return positions.reduce((sum, pos) => sum.add(pos.estimatedValue), new BN(0));
}

/**
 * Calculate current allocation weights from positions.
 */
export function getCurrentWeights(
  positions: StrategyPosition[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const total = getTotalDeployed(positions);

  if (total.isZero()) {
    return weights;
  }

  for (const pos of positions) {
    const weight = pos.estimatedValue.muln(10000).div(total).toNumber();
    weights.set(pos.strategyId, weight);
  }

  return weights;
}

/**
 * Check if strategy rebalancing is needed.
 */
export function strategyNeedsRebalance(
  positions: StrategyPosition[],
  targetWeights: Map<string, number>,
  thresholdBps: number,
): boolean {
  const currentWeights = getCurrentWeights(positions);

  for (const [strategyId, targetWeight] of targetWeights.entries()) {
    const currentWeight = currentWeights.get(strategyId) ?? 0;
    const diff = Math.abs(currentWeight - targetWeight);

    if (diff > thresholdBps) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Strategy Validation
// ============================================================================

/**
 * Validate strategy configuration.
 */
export function validateStrategyConfig(config: StrategyConfig): boolean {
  // Check max allocation is valid
  if (config.maxAllocationBps < 0 || config.maxAllocationBps > 10000) {
    return false;
  }

  // Check risk score is valid
  if (config.riskScore < 1 || config.riskScore > 10) {
    return false;
  }

  // Check expected APY is reasonable (max 1000% = 100000 bps)
  if (config.expectedApyBps < 0 || config.expectedApyBps > 100000) {
    return false;
  }

  // Check required accounts exist
  if (!config.accounts.protocolState) {
    return false;
  }

  return true;
}

/**
 * Validate target weights.
 */
export function validateTargetWeights(
  weights: Map<string, number>,
  strategies: StrategyConfig[],
): { valid: boolean; error?: string } {
  let totalWeight = 0;

  for (const [strategyId, weight] of weights.entries()) {
    // Check weight is non-negative
    if (weight < 0) {
      return {
        valid: false,
        error: `Negative weight for strategy ${strategyId}`,
      };
    }

    // Check strategy exists
    const strategy = strategies.find((s) => s.id === strategyId);
    if (!strategy) {
      return { valid: false, error: `Unknown strategy: ${strategyId}` };
    }

    // Check strategy is active
    if (strategy.status !== StrategyStatus.Active) {
      return {
        valid: false,
        error: `Strategy ${strategyId} is not active (status: ${strategy.status})`,
      };
    }

    // Check weight doesn't exceed max allocation
    if (weight > strategy.maxAllocationBps) {
      return {
        valid: false,
        error: `Weight ${weight} exceeds max allocation ${strategy.maxAllocationBps} for ${strategyId}`,
      };
    }

    totalWeight += weight;
  }

  // Weights should sum to 10000 (100%)
  if (totalWeight !== 10000) {
    return {
      valid: false,
      error: `Weights sum to ${totalWeight}, expected 10000`,
    };
  }

  return { valid: true };
}

// ============================================================================
// Health Monitoring
// ============================================================================

/**
 * Perform health check on a strategy position.
 */
export function checkStrategyHealth(
  position: StrategyPosition,
  strategy: StrategyConfig,
  currentExchangeRate: BN,
  lastExchangeRate: BN,
  currentTimestamp: number,
): HealthCheckResult {
  const issues: HealthIssue[] = [];
  const recommendations: string[] = [];
  let healthScore = 100;

  // Check if strategy is active
  if (strategy.status !== StrategyStatus.Active) {
    issues.push({
      severity: "high",
      code: "STRATEGY_NOT_ACTIVE",
      message: `Strategy status is ${strategy.status}`,
    });
    healthScore -= 30;
    recommendations.push("Consider recalling assets from deprecated strategy");
  }

  // Check for significant value loss (exchange rate drop > 5%)
  if (currentExchangeRate.lt(lastExchangeRate.muln(9500).divn(10000))) {
    const dropPercent =
      lastExchangeRate
        .sub(currentExchangeRate)
        .muln(10000)
        .div(lastExchangeRate)
        .toNumber() / 100;

    issues.push({
      severity: dropPercent > 10 ? "critical" : "high",
      code: "VALUE_LOSS",
      message: `Exchange rate dropped ${dropPercent.toFixed(2)}%`,
    });
    healthScore -= dropPercent > 10 ? 50 : 25;
    recommendations.push("Monitor closely, consider partial recall");
  }

  // Check sync staleness (> 1 day)
  const staleness = currentTimestamp - position.lastSyncTimestamp;
  if (staleness > 86400) {
    issues.push({
      severity: staleness > 604800 ? "high" : "medium",
      code: "STALE_DATA",
      message: `Position not synced for ${Math.floor(staleness / 86400)} days`,
    });
    healthScore -= staleness > 604800 ? 20 : 10;
    recommendations.push("Sync position to get accurate valuation");
  }

  // Check position size vs estimated value drift (> 10%)
  if (position.deployedAssets.gtn(0)) {
    const drift = position.estimatedValue
      .sub(position.deployedAssets)
      .abs()
      .muln(10000)
      .div(position.deployedAssets)
      .toNumber();

    if (drift > 1000) {
      // > 10%
      issues.push({
        severity: "low",
        code: "VALUE_DRIFT",
        message: `Estimated value differs from deployed by ${drift / 100}%`,
      });
      healthScore -= 5;
      recommendations.push("Review position for accuracy");
    }
  }

  return {
    strategyId: strategy.id,
    healthy:
      healthScore >= 70 && !issues.some((i) => i.severity === "critical"),
    healthScore: Math.max(0, healthScore),
    issues,
    recommendations,
  };
}

/**
 * Get aggregate portfolio health across all strategies.
 */
export function getPortfolioHealth(healthChecks: HealthCheckResult[]): {
  overallHealthy: boolean;
  averageScore: number;
  criticalIssues: number;
  totalIssues: number;
} {
  if (healthChecks.length === 0) {
    return {
      overallHealthy: true,
      averageScore: 100,
      criticalIssues: 0,
      totalIssues: 0,
    };
  }

  const totalScore = healthChecks.reduce((sum, h) => sum + h.healthScore, 0);
  const averageScore = totalScore / healthChecks.length;

  let criticalIssues = 0;
  let totalIssues = 0;

  for (const check of healthChecks) {
    for (const issue of check.issues) {
      totalIssues++;
      if (issue.severity === "critical") {
        criticalIssues++;
      }
    }
  }

  return {
    overallHealthy: averageScore >= 70 && criticalIssues === 0,
    averageScore,
    criticalIssues,
    totalIssues,
  };
}

// ============================================================================
// Strategy Manager Class
// ============================================================================

/**
 * Strategy manager for tracking and managing vault strategies.
 */
export class StrategyManager {
  private strategies: Map<string, StrategyConfig> = new Map();
  private positions: Map<string, StrategyPosition> = new Map();
  private targetWeights: Map<string, number> = new Map();

  constructor(strategies?: StrategyConfig[]) {
    if (strategies) {
      for (const s of strategies) {
        this.addStrategy(s);
      }
    }
  }

  /**
   * Add a strategy.
   */
  addStrategy(strategy: StrategyConfig): void {
    if (!validateStrategyConfig(strategy)) {
      throw new Error(`Invalid strategy config: ${strategy.id}`);
    }
    this.strategies.set(strategy.id, strategy);
  }

  /**
   * Remove a strategy (must have zero position).
   */
  removeStrategy(strategyId: string): boolean {
    const position = this.positions.get(strategyId);
    if (position && position.deployedAssets.gtn(0)) {
      return false;
    }
    this.strategies.delete(strategyId);
    this.positions.delete(strategyId);
    this.targetWeights.delete(strategyId);
    return true;
  }

  /**
   * Get strategy by ID.
   */
  getStrategy(strategyId: string): StrategyConfig | null {
    return this.strategies.get(strategyId) ?? null;
  }

  /**
   * Get all strategies.
   */
  getAllStrategies(onlyActive: boolean = false): StrategyConfig[] {
    const all = Array.from(this.strategies.values());
    if (onlyActive) {
      return all.filter((s) => s.status === StrategyStatus.Active);
    }
    return all;
  }

  /**
   * Update strategy status.
   */
  updateStrategyStatus(strategyId: string, status: StrategyStatus): boolean {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) return false;

    this.strategies.set(strategyId, { ...strategy, status });
    return true;
  }

  /**
   * Set target weights.
   */
  setTargetWeights(weights: Map<string, number>): {
    success: boolean;
    error?: string;
  } {
    const validation = validateTargetWeights(weights, this.getAllStrategies());
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    this.targetWeights = new Map(weights);
    return { success: true };
  }

  /**
   * Get target weights.
   */
  getTargetWeights(): Map<string, number> {
    return new Map(this.targetWeights);
  }

  /**
   * Update position.
   */
  updatePosition(position: StrategyPosition): void {
    this.positions.set(position.strategyId, position);
  }

  /**
   * Get position.
   */
  getPosition(strategyId: string): StrategyPosition | null {
    return this.positions.get(strategyId) ?? null;
  }

  /**
   * Get all positions.
   */
  getAllPositions(): StrategyPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get total deployed value.
   */
  getTotalDeployed(): BN {
    return getTotalDeployed(this.getAllPositions());
  }

  /**
   * Check if rebalancing is needed.
   */
  needsRebalance(thresholdBps: number): boolean {
    return strategyNeedsRebalance(
      this.getAllPositions(),
      this.targetWeights,
      thresholdBps,
    );
  }

  /**
   * Calculate allocations for a new deposit.
   */
  calculateAllocations(depositAmount: BN): StrategyAllocation[] {
    return calculateStrategyAllocations(
      depositAmount,
      this.getAllStrategies(true),
      this.targetWeights,
    );
  }

  /**
   * Calculate optimal recall amounts to reach target.
   */
  calculateRecallAmounts(
    targetTotal: BN,
  ): { strategyId: string; recallAmount: BN }[] {
    const currentTotal = this.getTotalDeployed();
    const recalls: { strategyId: string; recallAmount: BN }[] = [];

    if (targetTotal.gte(currentTotal)) {
      return recalls;
    }

    const toRecall = currentTotal.sub(targetTotal);
    let remaining = toRecall;

    // Sort by lowest priority (highest risk, lowest APY)
    const sortedPositions = this.getAllPositions()
      .filter((p) => p.estimatedValue.gtn(0))
      .map((p) => ({
        position: p,
        strategy: this.strategies.get(p.strategyId)!,
      }))
      .sort((a, b) => {
        // Higher risk first
        const riskDiff = b.strategy.riskScore - a.strategy.riskScore;
        if (riskDiff !== 0) return riskDiff;
        // Lower APY first
        return a.strategy.expectedApyBps - b.strategy.expectedApyBps;
      });

    for (const { position } of sortedPositions) {
      if (remaining.isZero()) break;

      const recallAmount = BN.min(remaining, position.estimatedValue);
      recalls.push({
        strategyId: position.strategyId,
        recallAmount,
      });
      remaining = remaining.sub(recallAmount);
    }

    return recalls;
  }
}

// ============================================================================
// Protocol-Specific Templates (Placeholder Helpers)
// ============================================================================

/**
 * Create a lending strategy config template.
 */
export function createLendingStrategy(
  id: string,
  name: string,
  programId: PublicKey,
  poolAccount: PublicKey,
  cTokenMint: PublicKey,
  options?: {
    maxAllocationBps?: number;
    expectedApyBps?: number;
    riskScore?: number;
  },
): StrategyConfig {
  return {
    id,
    name,
    type: StrategyType.Lending,
    programId,
    status: StrategyStatus.Active,
    maxAllocationBps: options?.maxAllocationBps ?? 5000, // 50% default
    expectedApyBps: options?.expectedApyBps ?? 500, // 5% default
    riskScore: options?.riskScore ?? 3,
    accounts: {
      protocolState: poolAccount,
      receiptMint: cTokenMint,
      additionalAccounts: [],
    },
  };
}

/**
 * Create a liquid staking strategy config template.
 */
export function createLiquidStakingStrategy(
  id: string,
  name: string,
  programId: PublicKey,
  stakePoolAccount: PublicKey,
  stakeMint: PublicKey,
  options?: {
    maxAllocationBps?: number;
    expectedApyBps?: number;
    riskScore?: number;
  },
): StrategyConfig {
  return {
    id,
    name,
    type: StrategyType.LiquidStaking,
    programId,
    status: StrategyStatus.Active,
    maxAllocationBps: options?.maxAllocationBps ?? 8000, // 80% default
    expectedApyBps: options?.expectedApyBps ?? 700, // 7% default
    riskScore: options?.riskScore ?? 2,
    accounts: {
      protocolState: stakePoolAccount,
      receiptMint: stakeMint,
      additionalAccounts: [],
    },
  };
}

/**
 * Create an LP strategy config template.
 */
export function createLpStrategy(
  id: string,
  name: string,
  programId: PublicKey,
  poolAccount: PublicKey,
  lpMint: PublicKey,
  options?: {
    maxAllocationBps?: number;
    expectedApyBps?: number;
    riskScore?: number;
  },
): StrategyConfig {
  return {
    id,
    name,
    type: StrategyType.LiquidityProvision,
    programId,
    status: StrategyStatus.Active,
    maxAllocationBps: options?.maxAllocationBps ?? 3000, // 30% default
    expectedApyBps: options?.expectedApyBps ?? 1500, // 15% default
    riskScore: options?.riskScore ?? 6,
    accounts: {
      protocolState: poolAccount,
      receiptMint: lpMint,
      additionalAccounts: [],
    },
  };
}

/**
 * Create an initial position state.
 */
export function createInitialPosition(
  strategyId: string,
  timestamp: number,
): StrategyPosition {
  return {
    strategyId,
    deployedAssets: new BN(0),
    receiptTokens: new BN(0),
    lastSyncTimestamp: timestamp,
    estimatedValue: new BN(0),
    accumulatedRewards: new BN(0),
  };
}

/**
 * Update position after deployment.
 */
export function updatePositionAfterDeploy(
  position: StrategyPosition,
  deployedAmount: BN,
  receiptTokensReceived: BN,
  exchangeRate: BN,
  timestamp: number,
): StrategyPosition {
  const SCALE = new BN(1_000_000_000);

  const newDeployed = position.deployedAssets.add(deployedAmount);
  const newReceipts = position.receiptTokens.add(receiptTokensReceived);
  const newEstimatedValue = newReceipts.mul(exchangeRate).div(SCALE);

  return {
    ...position,
    deployedAssets: newDeployed,
    receiptTokens: newReceipts,
    estimatedValue: newEstimatedValue,
    lastSyncTimestamp: timestamp,
  };
}

/**
 * Update position after recall.
 */
export function updatePositionAfterRecall(
  position: StrategyPosition,
  receiptTokensBurned: BN,
  assetsReceived: BN,
  exchangeRate: BN,
  timestamp: number,
): StrategyPosition {
  const SCALE = new BN(1_000_000_000);

  const newReceipts = position.receiptTokens.sub(receiptTokensBurned);
  const newEstimatedValue = newReceipts.mul(exchangeRate).div(SCALE);

  // Pro-rata deployed reduction
  const deployedReduction = position.deployedAssets
    .mul(receiptTokensBurned)
    .div(position.receiptTokens.isZero() ? new BN(1) : position.receiptTokens);
  const newDeployed = position.deployedAssets.sub(deployedReduction);

  return {
    ...position,
    deployedAssets: BN.max(newDeployed, new BN(0)),
    receiptTokens: newReceipts,
    estimatedValue: newEstimatedValue,
    lastSyncTimestamp: timestamp,
  };
}

/**
 * Update position value (sync without deposit/withdraw).
 */
export function syncPositionValue(
  position: StrategyPosition,
  exchangeRate: BN,
  timestamp: number,
): StrategyPosition {
  const SCALE = new BN(1_000_000_000);
  const newEstimatedValue = position.receiptTokens.mul(exchangeRate).div(SCALE);

  return {
    ...position,
    estimatedValue: newEstimatedValue,
    lastSyncTimestamp: timestamp,
  };
}
