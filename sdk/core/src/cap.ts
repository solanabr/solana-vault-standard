import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

/**
 * Deposit cap configuration
 */
export interface CapConfig {
  /** Maximum total assets in vault (null = unlimited) */
  globalCap: BN | null;
  /** Maximum assets per user (null = unlimited) */
  perUserCap: BN | null;
  /** Master switch to enable/disable caps */
  enabled: boolean;
}

/**
 * User's current position in the vault
 */
export interface UserPosition {
  /** User's public key */
  user: PublicKey;
  /** User's total deposited assets (tracked externally) */
  depositedAssets: BN;
  /** User's current share balance */
  shares: BN;
}

/**
 * Reason for cap violation
 */
export enum CapViolation {
  GlobalCapExceeded = "GLOBAL_CAP_EXCEEDED",
  UserCapExceeded = "USER_CAP_EXCEEDED",
}

/**
 * Result of a deposit cap check
 */
export interface CapCheckResult {
  /** Whether the deposit is allowed */
  allowed: boolean;
  /** Maximum additional deposit allowed */
  maxAllowedDeposit: BN;
  /** Reason if not allowed */
  reason?: CapViolation;
}

/**
 * Current cap utilization status
 */
export interface CapStatus {
  /** Global cap utilization (0-100) */
  globalUtilization: number;
  /** Remaining global capacity */
  globalRemaining: BN;
  /** User cap utilization (0-100) */
  userUtilization: number;
  /** Remaining user capacity */
  userRemaining: BN;
}

/**
 * Check if a deposit amount is within caps.
 */
export function checkDepositCap(
  depositAmount: BN,
  currentTotalAssets: BN,
  userCurrentDeposit: BN,
  config: CapConfig,
): CapCheckResult {
  if (!config.enabled) {
    return {
      allowed: true,
      maxAllowedDeposit: new BN("18446744073709551615"), // u64::MAX
    };
  }

  // Calculate max allowed for each cap
  let globalMax = new BN("18446744073709551615");
  let userMax = new BN("18446744073709551615");

  if (config.globalCap !== null) {
    const globalRemaining = config.globalCap.sub(currentTotalAssets);
    globalMax = globalRemaining.isNeg() ? new BN(0) : globalRemaining;
  }

  if (config.perUserCap !== null) {
    const userRemaining = config.perUserCap.sub(userCurrentDeposit);
    userMax = userRemaining.isNeg() ? new BN(0) : userRemaining;
  }

  const maxAllowedDeposit = BN.min(globalMax, userMax);

  // Check if deposit exceeds limits
  if (depositAmount.gt(maxAllowedDeposit)) {
    const reason =
      config.globalCap !== null &&
      depositAmount.gt(config.globalCap.sub(currentTotalAssets))
        ? CapViolation.GlobalCapExceeded
        : CapViolation.UserCapExceeded;

    return {
      allowed: false,
      maxAllowedDeposit,
      reason,
    };
  }

  return {
    allowed: true,
    maxAllowedDeposit,
  };
}

/**
 * Calculate maximum deposit allowed for a user.
 */
export function maxDeposit(
  currentTotalAssets: BN,
  userCurrentDeposit: BN,
  config: CapConfig,
): BN {
  if (!config.enabled) {
    return new BN("18446744073709551615");
  }

  let max = new BN("18446744073709551615");

  if (config.globalCap !== null) {
    const globalRemaining = config.globalCap.sub(currentTotalAssets);
    max = globalRemaining.isNeg() ? new BN(0) : globalRemaining;
  }

  if (config.perUserCap !== null) {
    const userRemaining = config.perUserCap.sub(userCurrentDeposit);
    const userMax = userRemaining.isNeg() ? new BN(0) : userRemaining;
    max = BN.min(max, userMax);
  }

  return max;
}

/**
 * Get current cap utilization status.
 */
export function getCapStatus(
  totalAssets: BN,
  userDeposit: BN,
  config: CapConfig,
): CapStatus {
  let globalUtilization = 0;
  let globalRemaining = new BN("18446744073709551615");

  if (
    config.enabled &&
    config.globalCap !== null &&
    !config.globalCap.isZero()
  ) {
    globalUtilization =
      (totalAssets.toNumber() / config.globalCap.toNumber()) * 100;
    globalUtilization = Math.min(100, Math.max(0, globalUtilization));

    const remaining = config.globalCap.sub(totalAssets);
    globalRemaining = remaining.isNeg() ? new BN(0) : remaining;
  }

  let userUtilization = 0;
  let userRemaining = new BN("18446744073709551615");

  if (
    config.enabled &&
    config.perUserCap !== null &&
    !config.perUserCap.isZero()
  ) {
    userUtilization =
      (userDeposit.toNumber() / config.perUserCap.toNumber()) * 100;
    userUtilization = Math.min(100, Math.max(0, userUtilization));

    const remaining = config.perUserCap.sub(userDeposit);
    userRemaining = remaining.isNeg() ? new BN(0) : remaining;
  }

  return {
    globalUtilization,
    globalRemaining,
    userUtilization,
    userRemaining,
  };
}

/**
 * Validate cap configuration.
 */
export function validateCapConfig(config: CapConfig): boolean {
  if (config.globalCap !== null && config.globalCap.isNeg()) {
    return false;
  }
  if (config.perUserCap !== null && config.perUserCap.isNeg()) {
    return false;
  }
  // Per-user cap shouldn't exceed global cap
  if (
    config.globalCap !== null &&
    config.perUserCap !== null &&
    config.perUserCap.gt(config.globalCap)
  ) {
    return false;
  }
  return true;
}

/**
 * Create a disabled cap configuration.
 */
export function createDisabledCapConfig(): CapConfig {
  return {
    globalCap: null,
    perUserCap: null,
    enabled: false,
  };
}

/**
 * Create a cap configuration with limits.
 */
export function createCapConfig(
  globalCap: BN | null,
  perUserCap: BN | null,
): CapConfig {
  return {
    globalCap,
    perUserCap,
    enabled: true,
  };
}

/**
 * Create a user position.
 */
export function createUserPosition(
  user: PublicKey,
  depositedAssets: BN,
  shares: BN,
): UserPosition {
  return {
    user,
    depositedAssets,
    shares,
  };
}
