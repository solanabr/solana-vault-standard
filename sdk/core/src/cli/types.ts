/**
 * CLI Type Definitions
 *
 * Core types for the Solana Vault CLI including configuration,
 * command context, output adapters, and automation settings.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN } from "@coral-xyz/anchor";

// ============================================================================
// Core Types
// ============================================================================

/** SVS program variant identifier */
export type SvsVariant = "svs-1" | "svs-2" | "svs-3" | "svs-4";

/** CLI output format */
export type OutputFormat = "table" | "json" | "csv";

/** Solana cluster name */
export type Cluster = "devnet" | "mainnet-beta" | "testnet" | "localnet";

/** Transaction commitment level */
export type Commitment = "processed" | "confirmed" | "finalized";

// ============================================================================
// CLI Context & Options
// ============================================================================

/**
 * Global options available on all CLI commands.
 * These are parsed from command-line flags.
 */
export interface GlobalOptions {
  /** Config profile to use */
  profile?: string;
  /** RPC endpoint URL */
  url?: string;
  /** Path to keypair file */
  keypair?: string;
  /** Output format (table, json, csv) */
  output?: OutputFormat;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Minimal output for scripts */
  quiet?: boolean;
  /** Skip confirmation prompts */
  yes?: boolean;
  /** Preview changes without executing */
  dryRun?: boolean;
}

/**
 * Runtime context passed to every command handler.
 * Created by middleware before command execution.
 */
export interface CliContext {
  /** Solana RPC connection */
  connection: Connection;
  /** Loaded wallet keypair */
  wallet: Keypair;
  /** Anchor provider for program interactions */
  provider: AnchorProvider;
  /** Loaded CLI configuration */
  config: CliConfig;
  /** Parsed global options */
  options: GlobalOptions;
  /** Output adapter for formatted output */
  output: OutputAdapter;
}

/**
 * Resolved vault information from address or alias.
 */
export interface ResolvedVault {
  /** Vault account address */
  address: PublicKey;
  /** SVS variant */
  variant: SvsVariant;
  /** Program ID for this vault */
  programId: PublicKey;
  /** Original alias name (if resolved from alias) */
  alias?: string;
  /** Asset mint address */
  assetMint?: PublicKey;
  /** Vault ID for multi-vault deployments */
  vaultId?: BN;
}

// ============================================================================
// Command Definition
// ============================================================================

/**
 * Command registration definition.
 * Used for declarative command registration.
 */
export interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  options?: OptionDefinition[];
  arguments?: ArgumentDefinition[];
  examples?: string[];
  requiresConnection?: boolean;
  requiresWallet?: boolean;
  action: (ctx: CliContext, args: Record<string, unknown>) => Promise<void>;
}

export interface OptionDefinition {
  flags: string;
  description: string;
  default?: unknown;
  required?: boolean;
  choices?: string[];
}

export interface ArgumentDefinition {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

// ============================================================================
// Output Adapter
// ============================================================================

/**
 * Spinner interface for progress indication.
 */
export interface Spinner {
  start(): Spinner;
  stop(): Spinner;
  succeed(message?: string): Spinner;
  fail(message?: string): Spinner;
  text: string;
}

/**
 * Output adapter for consistent CLI output.
 * Abstracts output formatting (table, json, csv) and logging levels.
 */
export interface OutputAdapter {
  /** Render data as table */
  table(headers: string[], rows: string[][]): void;
  /** Output JSON data */
  json(data: unknown): void;
  /** Output CSV data */
  csv(headers: string[], rows: string[][]): void;
  /** Success message (green) */
  success(message: string): void;
  /** Error message (red) */
  error(message: string): void;
  /** Warning message (yellow) */
  warn(message: string): void;
  /** Info message (default) */
  info(message: string): void;
  /** Debug message (only if verbose) */
  debug(message: string): void;
  /** Create spinner for progress */
  spinner(message: string): Spinner;
  /** Prompt for confirmation */
  confirm(message: string): Promise<boolean>;
  /** Current output format */
  format: OutputFormat;
  /** Verbose mode enabled */
  verbose: boolean;
  /** Quiet mode enabled */
  quiet: boolean;
}

// ============================================================================
// Dry Run
// ============================================================================

/**
 * Result of a dry-run simulation.
 */
export interface DryRunResult {
  operation: string;
  accountChanges: AccountChange[];
  estimatedCu: number;
  warnings: string[];
}

export interface AccountChange {
  address: string;
  type: "created" | "modified" | "deleted";
  before?: string;
  after?: string;
  description: string;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Safety guard configuration for vault operations.
 */
export interface GuardConfig {
  /** Maximum deposit amount per transaction */
  maxDepositPerTx?: string;
  /** Maximum withdrawal amount per transaction */
  maxWithdrawPerTx?: string;
  /** Daily deposit limit */
  dailyDepositLimit?: string;
  /** Daily withdrawal limit */
  dailyWithdrawLimit?: string;
  /** Cooldown between operations (seconds) */
  cooldownSeconds?: number;
  /** Auto-pause vault on anomaly detection */
  pauseOnAnomaly?: boolean;
  /** Anomaly detection thresholds */
  anomalyThresholds?: {
    priceChangePercent?: number;
    volumeSpike?: number;
  };
}

/**
 * Main CLI configuration structure.
 * Stored at ~/.solana-vault/config.yaml
 */
export interface CliConfig {
  /** Default settings */
  defaults: {
    cluster: Cluster;
    keypair: string;
    output: OutputFormat;
    confirmation: Commitment;
  };
  /** Named configuration profiles */
  profiles: Record<string, ProfileConfig>;
  /** Vault aliases for quick access */
  vaults: Record<string, VaultAlias>;
  /** Autopilot settings per vault */
  autopilot?: Record<string, AutopilotConfig>;
  /** Guard settings per vault */
  guards?: Record<string, GuardConfig>;
  /** Alert webhook configuration */
  alerts?: AlertsConfig;

  // Extended command configurations (stored as arbitrary objects)
  /** Fee configuration per vault */
  fees?: Record<string, unknown>;
  /** Cap configuration per vault */
  caps?: Record<string, unknown>;
  /** Access control configuration per vault */
  access?: Record<string, unknown>;
  /** Emergency withdrawal configuration per vault */
  emergency?: Record<string, unknown>;
  /** Timelock configuration per vault */
  timelock?: Record<string, unknown>;
  /** Strategy configuration per vault */
  strategies?: Record<string, unknown>;
  /** Multi-vault portfolio configuration */
  portfolio?: unknown;
}

/**
 * Configuration profile for different environments.
 */
export interface ProfileConfig {
  cluster?: Cluster;
  keypair?: string;
  confirmation?: Commitment;
  rpcEndpoint?: string;
}

/**
 * Vault alias for quick reference.
 */
export interface VaultAlias {
  /** Vault account address */
  address: string;
  /** SVS variant */
  variant: SvsVariant;
  /** Override program ID */
  programId?: string;
  /** Asset mint address */
  assetMint?: string;
  /** Vault ID for multi-vault */
  vaultId?: number;
  /** Human-readable name */
  name?: string;
}

// ============================================================================
// Automation
// ============================================================================

export interface HealthCheckConfig {
  enabled: boolean;
  interval: string;
  alertWebhook?: string;
  lastRun?: string;
}

/**
 * Autopilot configuration for automated vault operations.
 */
export interface AutopilotConfig {
  /** Auto-sync settings (SVS-2/SVS-4 only) */
  sync?: SyncConfig;
  /** Auto fee collection settings */
  fees?: FeesConfig;
  /** Auto-pause trigger settings */
  pause?: PauseConfig;
  /** Health monitoring settings */
  healthCheck?: HealthCheckConfig;
}

export interface SyncConfig {
  enabled: boolean;
  /** Sync interval (e.g., "1h", "30m", "1d") */
  interval: string;
  /** Minimum balance change to trigger sync */
  minChange?: number;
  lastRun?: string;
}

export interface FeesConfig {
  enabled: boolean;
  /** Minimum fees to trigger collection */
  threshold: string;
  /** Fee recipient address */
  recipient?: string;
  lastRun?: string;
}

export interface PauseConfig {
  enabled: boolean;
  triggers: PauseTrigger[];
}

export interface PauseTrigger {
  type: "large_withdrawal" | "rapid_activity" | "price_deviation";
  threshold: number;
  notify?: string[];
}

export interface AlertsConfig {
  discord?: string;
  email?: string;
  slack?: string;
}

// ============================================================================
// Middleware
// ============================================================================

export type MiddlewareFunction = (
  ctx: Partial<CliContext>,
  next: () => Promise<void>,
) => Promise<void>;

// ============================================================================
// Constants
// ============================================================================

/**
 * SVS program addresses by variant and cluster.
 */
export const SVS_PROGRAMS: Record<
  SvsVariant,
  { devnet: string; mainnet?: string }
> = {
  "svs-1": {
    devnet: "Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC",
  },
  "svs-2": {
    devnet: "3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD",
  },
  "svs-3": {
    devnet: "EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh",
  },
  "svs-4": {
    devnet: "2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY",
  },
};

/**
 * Default CLI configuration.
 */
export const DEFAULT_CONFIG: CliConfig = {
  defaults: {
    cluster: "devnet",
    keypair: "~/.config/solana/id.json",
    output: "table",
    confirmation: "confirmed",
  },
  profiles: {},
  vaults: {},
};
