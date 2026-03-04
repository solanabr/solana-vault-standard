import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

/**
 * Admin actions that can be timelocked
 */
export enum TimelockAction {
  TransferAuthority = "TRANSFER_AUTHORITY",
  UpdateFees = "UPDATE_FEES",
  UpdateCaps = "UPDATE_CAPS",
  UpdateAccessControl = "UPDATE_ACCESS_CONTROL",
  Pause = "PAUSE",
  Unpause = "UNPAUSE",
  EmergencyWithdraw = "EMERGENCY_WITHDRAW",
}

/**
 * Timelock configuration
 */
export interface TimelockConfig {
  /** Minimum delay in seconds (e.g., 86400 = 1 day) */
  minDelay: number;
  /** Maximum delay in seconds (e.g., 604800 = 7 days) */
  maxDelay: number;
  /** Grace period after unlock to execute (seconds) */
  gracePeriod: number;
  /** Admin who can propose actions */
  admin: PublicKey;
  /** Executor who can execute (defaults to admin) */
  executor: PublicKey;
}

/**
 * Proposal status
 */
export enum ProposalStatus {
  Pending = "PENDING",
  Ready = "READY",
  Executed = "EXECUTED",
  Cancelled = "CANCELLED",
  Expired = "EXPIRED",
}

/**
 * A timelocked proposal
 */
export interface Proposal {
  /** Unique identifier (hash) */
  id: string;
  /** Action being proposed */
  action: TimelockAction;
  /** Action-specific parameters */
  params: unknown;
  /** Who proposed */
  proposer: PublicKey;
  /** When proposed (unix timestamp) */
  proposedAt: number;
  /** Earliest execution time (unix timestamp) */
  executeAfter: number;
  /** Latest execution time (unix timestamp) */
  expiresAt: number;
  /** Current status */
  status: ProposalStatus;
}

/**
 * Result of checking if a proposal can execute
 */
export interface ExecuteCheckResult {
  /** Whether the proposal can be executed */
  executable: boolean;
  /** Reason if not executable */
  reason?: string;
  /** Seconds remaining until executable */
  waitTime?: number;
}

/**
 * Time remaining for a proposal
 */
export interface TimeRemaining {
  /** Seconds until proposal becomes ready (0 if already ready) */
  toReady: number;
  /** Seconds until proposal expires */
  toExpiry: number;
}

/**
 * Generate a unique proposal ID from action, params, and salt.
 */
export function generateProposalId(
  action: TimelockAction,
  params: unknown,
  salt: Buffer,
): string {
  const data = Buffer.from(
    JSON.stringify({ action, params }) + salt.toString("hex"),
  );
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Create a new proposal.
 */
export function createProposal(
  action: TimelockAction,
  params: unknown,
  config: TimelockConfig,
  currentTimestamp: number,
  delay?: number,
): Proposal {
  // Use provided delay or default to minimum
  const actualDelay = delay ?? config.minDelay;

  // Validate delay is within bounds
  if (actualDelay < config.minDelay || actualDelay > config.maxDelay) {
    throw new Error(
      `Delay ${actualDelay} is outside bounds [${config.minDelay}, ${config.maxDelay}]`,
    );
  }

  const executeAfter = currentTimestamp + actualDelay;
  const expiresAt = executeAfter + config.gracePeriod;

  // Generate unique ID with random salt
  const salt = Buffer.from(Date.now().toString() + Math.random().toString());
  const id = generateProposalId(action, params, salt);

  return {
    id,
    action,
    params,
    proposer: config.admin,
    proposedAt: currentTimestamp,
    executeAfter,
    expiresAt,
    status: ProposalStatus.Pending,
  };
}

/**
 * Check if a proposal can be executed.
 */
export function canExecute(
  proposal: Proposal,
  currentTimestamp: number,
): ExecuteCheckResult {
  // Already executed or cancelled
  if (proposal.status === ProposalStatus.Executed) {
    return { executable: false, reason: "Already executed" };
  }
  if (proposal.status === ProposalStatus.Cancelled) {
    return { executable: false, reason: "Proposal cancelled" };
  }

  // Check if expired
  if (currentTimestamp > proposal.expiresAt) {
    return { executable: false, reason: "Proposal expired" };
  }

  // Check if not yet ready
  if (currentTimestamp < proposal.executeAfter) {
    return {
      executable: false,
      reason: "Delay not elapsed",
      waitTime: proposal.executeAfter - currentTimestamp,
    };
  }

  return { executable: true };
}

/**
 * Get the current status of a proposal.
 */
export function getProposalStatus(
  proposal: Proposal,
  currentTimestamp: number,
): ProposalStatus {
  // Terminal states
  if (proposal.status === ProposalStatus.Executed) {
    return ProposalStatus.Executed;
  }
  if (proposal.status === ProposalStatus.Cancelled) {
    return ProposalStatus.Cancelled;
  }

  // Check expiry
  if (currentTimestamp > proposal.expiresAt) {
    return ProposalStatus.Expired;
  }

  // Check if ready
  if (currentTimestamp >= proposal.executeAfter) {
    return ProposalStatus.Ready;
  }

  return ProposalStatus.Pending;
}

/**
 * Get time remaining for a proposal.
 */
export function getTimeRemaining(
  proposal: Proposal,
  currentTimestamp: number,
): TimeRemaining {
  const toReady = Math.max(0, proposal.executeAfter - currentTimestamp);
  const toExpiry = Math.max(0, proposal.expiresAt - currentTimestamp);

  return { toReady, toExpiry };
}

/**
 * Mark a proposal as executed.
 * Returns a new proposal object (immutable).
 */
export function markExecuted(proposal: Proposal): Proposal {
  return {
    ...proposal,
    status: ProposalStatus.Executed,
  };
}

/**
 * Mark a proposal as cancelled.
 * Returns a new proposal object (immutable).
 */
export function markCancelled(proposal: Proposal): Proposal {
  return {
    ...proposal,
    status: ProposalStatus.Cancelled,
  };
}

/**
 * Create a timelock configuration.
 */
export function createTimelockConfig(
  admin: PublicKey,
  options?: {
    minDelay?: number;
    maxDelay?: number;
    gracePeriod?: number;
    executor?: PublicKey;
  },
): TimelockConfig {
  return {
    minDelay: options?.minDelay ?? 86400, // 1 day default
    maxDelay: options?.maxDelay ?? 604800, // 7 days default
    gracePeriod: options?.gracePeriod ?? 86400, // 1 day default
    admin,
    executor: options?.executor ?? admin,
  };
}

/**
 * Validate timelock configuration.
 */
export function validateTimelockConfig(config: TimelockConfig): boolean {
  if (config.minDelay < 0) {
    return false;
  }
  if (config.maxDelay < config.minDelay) {
    return false;
  }
  if (config.gracePeriod < 0) {
    return false;
  }
  return true;
}

/**
 * In-memory timelock manager for tracking proposals.
 */
export class TimelockManager {
  private proposals: Map<string, Proposal> = new Map();
  private config: TimelockConfig;

  constructor(config: TimelockConfig) {
    this.config = config;
  }

  /**
   * Propose a new action.
   */
  propose(
    action: TimelockAction,
    params: unknown,
    currentTimestamp: number,
    delay?: number,
  ): Proposal {
    const proposal = createProposal(
      action,
      params,
      this.config,
      currentTimestamp,
      delay,
    );
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  /**
   * Execute a ready proposal.
   */
  execute(proposalId: string, currentTimestamp: number): ExecuteCheckResult {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return { executable: false, reason: "Proposal not found" };
    }

    const check = canExecute(proposal, currentTimestamp);
    if (!check.executable) {
      return check;
    }

    // Mark as executed
    this.proposals.set(proposalId, markExecuted(proposal));
    return { executable: true };
  }

  /**
   * Cancel a pending proposal.
   */
  cancel(proposalId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return false;
    }

    // Can only cancel pending or ready proposals
    if (
      proposal.status === ProposalStatus.Executed ||
      proposal.status === ProposalStatus.Cancelled
    ) {
      return false;
    }

    this.proposals.set(proposalId, markCancelled(proposal));
    return true;
  }

  /**
   * Get a proposal by ID.
   */
  getProposal(id: string): Proposal | null {
    return this.proposals.get(id) ?? null;
  }

  /**
   * Get all pending proposals.
   */
  getPendingProposals(currentTimestamp: number): Proposal[] {
    const pending: Proposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (
        getProposalStatus(proposal, currentTimestamp) === ProposalStatus.Pending
      ) {
        pending.push(proposal);
      }
    }
    return pending;
  }

  /**
   * Get all ready proposals.
   */
  getReadyProposals(currentTimestamp: number): Proposal[] {
    const ready: Proposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (
        getProposalStatus(proposal, currentTimestamp) === ProposalStatus.Ready
      ) {
        ready.push(proposal);
      }
    }
    return ready;
  }

  /**
   * Get all proposals (optionally filtered by action).
   */
  getAllProposals(action?: TimelockAction): Proposal[] {
    const proposals = Array.from(this.proposals.values());
    if (action) {
      return proposals.filter((p) => p.action === action);
    }
    return proposals;
  }

  /**
   * Clean up expired proposals.
   */
  cleanup(currentTimestamp: number): number {
    let removed = 0;
    for (const [id, proposal] of this.proposals.entries()) {
      const status = getProposalStatus(proposal, currentTimestamp);
      if (
        status === ProposalStatus.Expired ||
        status === ProposalStatus.Executed ||
        status === ProposalStatus.Cancelled
      ) {
        this.proposals.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
