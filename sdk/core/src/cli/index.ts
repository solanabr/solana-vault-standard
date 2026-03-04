/**
 * Solana Vault CLI
 *
 * Command-line interface for managing SVS vaults. Provides commands for:
 * - Inspecting vault state and balances
 * - Depositing, withdrawing, minting, and redeeming
 * - Admin operations (pause, unpause, sync, transfer authority)
 * - Monitoring (dashboard, health checks)
 * - Automation (autopilot, batch operations, guards)
 *
 * @example
 * ```bash
 * # Initialize config
 * solana-vault config init
 *
 * # Add vault alias
 * solana-vault config add-vault my-vault <ADDRESS> --variant svs-1
 *
 * # Check vault info
 * solana-vault info my-vault
 *
 * # Deposit with slippage protection
 * solana-vault deposit my-vault -a 1000000 --slippage 50
 * ```
 */

import { Command } from "commander";
import { GlobalOptions } from "./types";

// Inspect commands
import { registerInfoCommand } from "./commands/inspect/info";
import { registerPreviewCommand } from "./commands/inspect/preview";
import { registerListCommand } from "./commands/inspect/list";
import { registerBalanceCommand } from "./commands/inspect/balance";
import { registerHistoryCommand } from "./commands/inspect/history";

// Operate commands
import { registerDepositCommand } from "./commands/operate/deposit";
import { registerWithdrawCommand } from "./commands/operate/withdraw";
import { registerMintCommand } from "./commands/operate/mint";
import { registerRedeemCommand } from "./commands/operate/redeem";

// Admin commands
import { registerPauseCommand } from "./commands/admin/pause";
import { registerUnpauseCommand } from "./commands/admin/unpause";
import { registerSyncCommand } from "./commands/admin/sync";
import { registerTransferAuthorityCommand } from "./commands/admin/transfer-authority";
import { registerPermissionsCommand } from "./commands/admin/permissions";

// Monitor commands
import { registerHealthCommand } from "./commands/monitor/health";
import { registerDashboardCommand } from "./commands/monitor/dashboard";

// Offline commands
import { registerConvertCommand } from "./commands/offline/convert";
import { registerDeriveCommand } from "./commands/offline/derive";

// Config & automation commands
import { registerConfigCommands } from "./commands/config-cmd";
import { registerAutomationCommands } from "./commands/automation";

/**
 * Create and configure the CLI program.
 *
 * @returns Configured Commander program ready to parse arguments
 */
export function createCli(): Command {
  const program = new Command();

  program
    .name("solana-vault")
    .description("CLI for Solana Vault Standard (SVS)")
    .version("0.2.0");

  addGlobalOptions(program);

  // Register command groups
  registerInspectCommands(program);
  registerOperateCommands(program);
  registerAdminCommands(program);
  registerMonitorCommands(program);
  registerAutomationCommands(program);
  registerOfflineCommands(program);
  registerConfigCommands(program);

  return program;
}

/**
 * Add global options available on all commands.
 */
function addGlobalOptions(program: Command): void {
  program
    .option("-u, --url <url>", "RPC URL")
    .option("-k, --keypair <path>", "Path to keypair file")
    .option("-o, --output <format>", "Output format: table, json, csv", "table")
    .option("-p, --profile <name>", "Use saved config profile")
    .option("-v, --verbose", "Show detailed output")
    .option("-q, --quiet", "Minimal output (for scripts)")
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--dry-run", "Preview changes without executing");
}

/** Register vault inspection commands */
function registerInspectCommands(program: Command): void {
  registerInfoCommand(program);
  registerPreviewCommand(program);
  registerListCommand(program);
  registerBalanceCommand(program);
  registerHistoryCommand(program);
}

/** Register vault operation commands */
function registerOperateCommands(program: Command): void {
  registerDepositCommand(program);
  registerWithdrawCommand(program);
  registerMintCommand(program);
  registerRedeemCommand(program);
}

/** Register admin-only commands */
function registerAdminCommands(program: Command): void {
  registerPauseCommand(program);
  registerUnpauseCommand(program);
  registerSyncCommand(program);
  registerTransferAuthorityCommand(program);
  registerPermissionsCommand(program);
}

/** Register monitoring commands */
function registerMonitorCommands(program: Command): void {
  registerHealthCommand(program);
  registerDashboardCommand(program);
}

/** Register offline utility commands */
function registerOfflineCommands(program: Command): void {
  registerConvertCommand(program);
  registerDeriveCommand(program);
}

/**
 * Extract global options from parsed program.
 *
 * @param program - Commander program after parsing
 * @returns Global options object
 */
export function getGlobalOptions(program: Command): GlobalOptions {
  const opts = program.opts();
  return {
    url: opts.url,
    keypair: opts.keypair,
    output: opts.output,
    profile: opts.profile,
    verbose: opts.verbose,
    quiet: opts.quiet,
    yes: opts.yes,
    dryRun: opts.dryRun,
  };
}
