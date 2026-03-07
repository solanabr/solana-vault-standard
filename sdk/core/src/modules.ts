/**
 * Module PDA Derivation and Types
 *
 * On-chain module account derivation and TypeScript types.
 * These modules are conditionally compiled into vault programs
 * when built with the "modules" feature flag.
 *
 * Module PDAs:
 * - FeeConfig: ["fee_config", vault]
 * - CapConfig: ["cap_config", vault]
 * - UserDeposit: ["user_deposit", vault, user]
 * - LockConfig: ["lock_config", vault]
 * - ShareLock: ["share_lock", vault, owner]
 * - AccessConfig: ["access_config", vault]
 * - FrozenAccount: ["frozen", vault, user]
 * - RewardConfig: ["reward_config", vault, reward_mint]
 * - UserReward: ["user_reward", vault, reward_mint, user]
 *
 * @example
 * ```ts
 * import { deriveModuleAddresses, getFeeConfigAddress } from "./modules";
 *
 * // Get all module PDAs for a vault
 * const modules = deriveModuleAddresses(programId, vault);
 *
 * // Or derive individually
 * const [feeConfig, bump] = getFeeConfigAddress(programId, vault);
 * ```
 */

import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

// =============================================================================
// PDA Seeds (must match on-chain constants in state.rs)
// =============================================================================

export const FEE_CONFIG_SEED = Buffer.from("fee_config");
export const CAP_CONFIG_SEED = Buffer.from("cap_config");
export const USER_DEPOSIT_SEED = Buffer.from("user_deposit");
export const LOCK_CONFIG_SEED = Buffer.from("lock_config");
export const SHARE_LOCK_SEED = Buffer.from("share_lock");
export const ACCESS_CONFIG_SEED = Buffer.from("access_config");
export const FROZEN_ACCOUNT_SEED = Buffer.from("frozen");
export const REWARD_CONFIG_SEED = Buffer.from("reward_config");
export const USER_REWARD_SEED = Buffer.from("user_reward");

// =============================================================================
// Access Mode Enum (matches on-chain AccessMode)
// =============================================================================

/**
 * On-chain access mode enum (matches Anchor IDL)
 *
 * NOTE: This is the on-chain compatible numeric version.
 * For client-side string-based version, use `AccessMode` from "./access-control"
 */
export enum OnChainAccessMode {
  /** Open access - anyone can interact */
  Open = 0,
  /** Whitelist - only addresses with valid merkle proofs */
  Whitelist = 1,
  /** Blacklist - anyone except addresses with valid merkle proofs */
  Blacklist = 2,
}

// =============================================================================
// Module Account Types (match on-chain state structs)
// =============================================================================

/**
 * Fee configuration account
 * Seeds: ["fee_config", vault]
 */
export interface FeeConfigAccount {
  vault: PublicKey;
  feeRecipient: PublicKey;
  entryFeeBps: number;
  exitFeeBps: number;
  managementFeeBps: number;
  performanceFeeBps: number;
  highWaterMark: BN;
  lastFeeCollection: BN;
  bump: number;
}

/**
 * Deposit cap configuration account
 * Seeds: ["cap_config", vault]
 */
export interface CapConfigAccount {
  vault: PublicKey;
  globalCap: BN;
  perUserCap: BN;
  bump: number;
}

/**
 * User deposit tracking account (for per-user caps)
 * Seeds: ["user_deposit", vault, user]
 */
export interface UserDepositAccount {
  vault: PublicKey;
  user: PublicKey;
  cumulativeAssets: BN;
  bump: number;
}

/**
 * Time-lock configuration account
 * Seeds: ["lock_config", vault]
 */
export interface LockConfigAccount {
  vault: PublicKey;
  lockDuration: BN;
  bump: number;
}

/**
 * User share lock account
 * Seeds: ["share_lock", vault, owner]
 */
export interface ShareLockAccount {
  vault: PublicKey;
  owner: PublicKey;
  lockedUntil: BN;
  bump: number;
}

/**
 * Access control configuration account
 * Seeds: ["access_config", vault]
 */
export interface AccessConfigAccount {
  vault: PublicKey;
  mode: OnChainAccessMode;
  merkleRoot: Uint8Array; // 32 bytes
  bump: number;
}

/**
 * Frozen account marker
 * Seeds: ["frozen", vault, user]
 */
export interface FrozenAccountState {
  vault: PublicKey;
  user: PublicKey;
  frozenBy: PublicKey;
  frozenAt: BN;
  bump: number;
}

/**
 * Reward distribution configuration account
 * Seeds: ["reward_config", vault, reward_mint]
 */
export interface RewardConfigAccount {
  vault: PublicKey;
  rewardMint: PublicKey;
  rewardVault: PublicKey;
  rewardAuthority: PublicKey;
  accumulatedPerShare: BN; // u128 scaled by 1e18
  lastUpdate: BN;
  bump: number;
}

/**
 * User reward tracking account
 * Seeds: ["user_reward", vault, reward_mint, user]
 */
export interface UserRewardAccount {
  vault: PublicKey;
  user: PublicKey;
  rewardMint: PublicKey;
  rewardDebt: BN; // u128 scaled by 1e18
  unclaimed: BN;
  bump: number;
}

// =============================================================================
// PDA Derivation Functions
// =============================================================================

/**
 * Derive the FeeConfig PDA address
 */
export function getFeeConfigAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FEE_CONFIG_SEED, vault.toBuffer()],
    programId,
  );
}

/**
 * Derive the CapConfig PDA address
 */
export function getCapConfigAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CAP_CONFIG_SEED, vault.toBuffer()],
    programId,
  );
}

/**
 * Derive the UserDeposit PDA address
 */
export function getUserDepositAddress(
  programId: PublicKey,
  vault: PublicKey,
  user: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [USER_DEPOSIT_SEED, vault.toBuffer(), user.toBuffer()],
    programId,
  );
}

/**
 * Derive the LockConfig PDA address
 */
export function getLockConfigAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [LOCK_CONFIG_SEED, vault.toBuffer()],
    programId,
  );
}

/**
 * Derive the ShareLock PDA address
 */
export function getShareLockAddress(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SHARE_LOCK_SEED, vault.toBuffer(), owner.toBuffer()],
    programId,
  );
}

/**
 * Derive the AccessConfig PDA address
 */
export function getAccessConfigAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ACCESS_CONFIG_SEED, vault.toBuffer()],
    programId,
  );
}

/**
 * Derive the FrozenAccount PDA address
 */
export function getFrozenAccountAddress(
  programId: PublicKey,
  vault: PublicKey,
  user: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FROZEN_ACCOUNT_SEED, vault.toBuffer(), user.toBuffer()],
    programId,
  );
}

/**
 * Derive the RewardConfig PDA address
 */
export function getRewardConfigAddress(
  programId: PublicKey,
  vault: PublicKey,
  rewardMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REWARD_CONFIG_SEED, vault.toBuffer(), rewardMint.toBuffer()],
    programId,
  );
}

/**
 * Derive the UserReward PDA address
 */
export function getUserRewardAddress(
  programId: PublicKey,
  vault: PublicKey,
  rewardMint: PublicKey,
  user: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      USER_REWARD_SEED,
      vault.toBuffer(),
      rewardMint.toBuffer(),
      user.toBuffer(),
    ],
    programId,
  );
}

// =============================================================================
// Combined Module Address Derivation
// =============================================================================

/**
 * All module configuration PDAs for a vault
 */
export interface ModuleAddresses {
  feeConfig: PublicKey;
  feeConfigBump: number;
  capConfig: PublicKey;
  capConfigBump: number;
  lockConfig: PublicKey;
  lockConfigBump: number;
  accessConfig: PublicKey;
  accessConfigBump: number;
}

/**
 * User-specific module PDAs for a vault
 */
export interface UserModuleAddresses {
  userDeposit: PublicKey;
  userDepositBump: number;
  shareLock: PublicKey;
  shareLockBump: number;
  frozenAccount: PublicKey;
  frozenAccountBump: number;
}

/**
 * Reward-specific module PDAs
 */
export interface RewardModuleAddresses {
  rewardConfig: PublicKey;
  rewardConfigBump: number;
  userReward: PublicKey;
  userRewardBump: number;
}

/**
 * Derive all vault-level module configuration addresses
 */
export function deriveModuleAddresses(
  programId: PublicKey,
  vault: PublicKey,
): ModuleAddresses {
  const [feeConfig, feeConfigBump] = getFeeConfigAddress(programId, vault);
  const [capConfig, capConfigBump] = getCapConfigAddress(programId, vault);
  const [lockConfig, lockConfigBump] = getLockConfigAddress(programId, vault);
  const [accessConfig, accessConfigBump] = getAccessConfigAddress(
    programId,
    vault,
  );

  return {
    feeConfig,
    feeConfigBump,
    capConfig,
    capConfigBump,
    lockConfig,
    lockConfigBump,
    accessConfig,
    accessConfigBump,
  };
}

/**
 * Derive all user-specific module addresses for a vault
 */
export function deriveUserModuleAddresses(
  programId: PublicKey,
  vault: PublicKey,
  user: PublicKey,
): UserModuleAddresses {
  const [userDeposit, userDepositBump] = getUserDepositAddress(
    programId,
    vault,
    user,
  );
  const [shareLock, shareLockBump] = getShareLockAddress(
    programId,
    vault,
    user,
  );
  const [frozenAccount, frozenAccountBump] = getFrozenAccountAddress(
    programId,
    vault,
    user,
  );

  return {
    userDeposit,
    userDepositBump,
    shareLock,
    shareLockBump,
    frozenAccount,
    frozenAccountBump,
  };
}

/**
 * Derive reward-related module addresses
 */
export function deriveRewardModuleAddresses(
  programId: PublicKey,
  vault: PublicKey,
  rewardMint: PublicKey,
  user: PublicKey,
): RewardModuleAddresses {
  const [rewardConfig, rewardConfigBump] = getRewardConfigAddress(
    programId,
    vault,
    rewardMint,
  );
  const [userReward, userRewardBump] = getUserRewardAddress(
    programId,
    vault,
    rewardMint,
    user,
  );

  return {
    rewardConfig,
    rewardConfigBump,
    userReward,
    userRewardBump,
  };
}

// =============================================================================
// Module Account Fetching Utilities
// =============================================================================

/**
 * Result of checking if module configs exist on-chain
 */
export interface ModuleConfigStatus {
  feeConfigExists: boolean;
  capConfigExists: boolean;
  lockConfigExists: boolean;
  accessConfigExists: boolean;
}

/**
 * Options for module-aware operations
 */
export interface ModuleOptions {
  /** Include fee config account if it exists */
  includeFees?: boolean;
  /** Include cap config and user deposit accounts if they exist */
  includeCaps?: boolean;
  /** Include lock config and share lock accounts if they exist */
  includeLocks?: boolean;
  /** Include access config and frozen account if they exist */
  includeAccess?: boolean;
  /** Include reward config and user reward accounts if they exist */
  includeRewards?: {
    rewardMint: PublicKey;
  };
  /** Merkle proof for access control (if using whitelist/blacklist) */
  merkleProof?: Uint8Array[];
}

/**
 * Resolved module accounts for transaction building
 */
export interface ResolvedModuleAccounts {
  feeConfig?: PublicKey;
  capConfig?: PublicKey;
  userDeposit?: PublicKey;
  lockConfig?: PublicKey;
  shareLock?: PublicKey;
  accessConfig?: PublicKey;
  frozenAccount?: PublicKey;
  rewardConfig?: PublicKey;
  userReward?: PublicKey;
}

/**
 * Resolve module accounts that exist on-chain for remaining_accounts
 *
 * @param connection - Solana connection
 * @param programId - Vault program ID
 * @param vault - Vault address
 * @param user - User address
 * @param options - Which modules to include
 * @returns Resolved accounts that exist on-chain
 */
export async function resolveModuleAccounts(
  connection: { getAccountInfo: (pubkey: PublicKey) => Promise<unknown> },
  programId: PublicKey,
  vault: PublicKey,
  user: PublicKey,
  options: ModuleOptions = {},
): Promise<ResolvedModuleAccounts> {
  const result: ResolvedModuleAccounts = {};
  const checks: Array<Promise<void>> = [];

  if (options.includeFees) {
    const [feeConfig] = getFeeConfigAddress(programId, vault);
    checks.push(
      connection.getAccountInfo(feeConfig).then((info) => {
        if (info) result.feeConfig = feeConfig;
      }),
    );
  }

  if (options.includeCaps) {
    const [capConfig] = getCapConfigAddress(programId, vault);
    const [userDeposit] = getUserDepositAddress(programId, vault, user);
    checks.push(
      connection.getAccountInfo(capConfig).then((info) => {
        if (info) {
          result.capConfig = capConfig;
          result.userDeposit = userDeposit;
        }
      }),
    );
  }

  if (options.includeLocks) {
    const [lockConfig] = getLockConfigAddress(programId, vault);
    const [shareLock] = getShareLockAddress(programId, vault, user);
    checks.push(
      connection.getAccountInfo(lockConfig).then((info) => {
        if (info) {
          result.lockConfig = lockConfig;
          result.shareLock = shareLock;
        }
      }),
    );
  }

  if (options.includeAccess) {
    const [accessConfig] = getAccessConfigAddress(programId, vault);
    const [frozenAccount] = getFrozenAccountAddress(programId, vault, user);
    checks.push(
      connection.getAccountInfo(accessConfig).then((info) => {
        if (info) {
          result.accessConfig = accessConfig;
          result.frozenAccount = frozenAccount;
        }
      }),
    );
  }

  if (options.includeRewards) {
    const { rewardMint } = options.includeRewards;
    const [rewardConfig] = getRewardConfigAddress(programId, vault, rewardMint);
    const [userReward] = getUserRewardAddress(
      programId,
      vault,
      rewardMint,
      user,
    );
    checks.push(
      connection.getAccountInfo(rewardConfig).then((info) => {
        if (info) {
          result.rewardConfig = rewardConfig;
          result.userReward = userReward;
        }
      }),
    );
  }

  await Promise.all(checks);
  return result;
}

/**
 * Check which module configs exist for a vault
 */
export async function checkModuleStatus(
  connection: {
    getMultipleAccountsInfo: (
      pubkeys: PublicKey[],
    ) => Promise<(unknown | null)[]>;
  },
  programId: PublicKey,
  vault: PublicKey,
): Promise<ModuleConfigStatus> {
  const addresses = deriveModuleAddresses(programId, vault);
  const pubkeys = [
    addresses.feeConfig,
    addresses.capConfig,
    addresses.lockConfig,
    addresses.accessConfig,
  ];

  const accounts = await connection.getMultipleAccountsInfo(pubkeys);

  return {
    feeConfigExists: accounts[0] !== null,
    capConfigExists: accounts[1] !== null,
    lockConfigExists: accounts[2] !== null,
    accessConfigExists: accounts[3] !== null,
  };
}
