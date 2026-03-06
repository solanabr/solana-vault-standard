/** Timelock Commands - Manage timelocked proposals for vault operations */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVaultArg, saveConfig, isValidPublicKey } from "../../utils";
import {
  TimelockConfig,
  TimelockAction,
  ProposalStatus,
  createTimelockConfig,
  validateTimelockConfig,
  getProposalStatus,
  canExecute,
  createProposal,
} from "../../../timelock";

// Stored proposal format (serializable)
interface StoredProposal {
  id: string;
  action: TimelockAction;
  params: Record<string, unknown>;
  proposedAt: number;
  executeAfter: number;
  expiresAt?: number;
  executed?: boolean;
  cancelled?: boolean;
  status: ProposalStatus;
}

export function registerTimelockCommands(program: Command): void {
  const timelock = program
    .command("timelock")
    .description("Manage timelocked proposals for vault operations");

  timelock
    .command("show")
    .description("Show timelock configuration and pending proposals")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const timelockData = config.timelock?.[vaultArg] as
        | {
            config?: {
              admin: string;
              minDelay: number;
              maxDelay?: number;
            };
            proposals?: Record<string, StoredProposal>;
          }
        | undefined;

      if (!timelockData?.config) {
        output.info(`No timelock configured for ${vaultArg}`);
        output.info("");
        output.info("Configure timelock with:");
        output.info(
          `  solana-vault timelock configure ${vaultArg} --min-delay 86400`,
        );
        return;
      }

      const timelockConfig = timelockData.config;
      const proposals = timelockData.proposals ?? {};
      const now = Math.floor(Date.now() / 1000);

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          config: timelockConfig,
          proposals: Object.values(proposals),
        });
        return;
      }

      output.info(`Timelock Configuration for ${vaultArg}\n`);
      output.table(
        ["Setting", "Value"],
        [
          ["Minimum Delay", `${timelockConfig.minDelay} seconds`],
          [
            "Maximum Delay",
            timelockConfig.maxDelay
              ? `${timelockConfig.maxDelay} seconds`
              : "None",
          ],
          ["Admin", timelockConfig.admin],
        ],
      );

      const proposalList = Object.entries(proposals);
      if (proposalList.length > 0) {
        output.info("\nPending Proposals:");
        const proposalRows: [string, string, string, string][] =
          proposalList.map(([id, p]) => {
            const timeRemaining = p.executeAfter - now;
            const status = p.executed
              ? ProposalStatus.Executed
              : p.cancelled
                ? ProposalStatus.Cancelled
                : timeRemaining <= 0
                  ? ProposalStatus.Ready
                  : ProposalStatus.Pending;
            return [
              id.slice(0, 8) + "...",
              p.action,
              status,
              timeRemaining > 0 ? `${timeRemaining}s` : "Ready",
            ];
          });
        output.table(["ID", "Action", "Status", "Time Left"], proposalRows);
      } else {
        output.info("\nNo pending proposals.");
      }
    });

  timelock
    .command("configure")
    .description("Configure timelock settings")
    .argument("<vault>", "Vault address or alias")
    .requiredOption(
      "--min-delay <seconds>",
      "Minimum delay for proposals (seconds)",
    )
    .option("--max-delay <seconds>", "Maximum delay for proposals (seconds)")
    .option("--admin <pubkey>", "Timelock admin address")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const minDelay = parseInt(opts.minDelay);
      if (isNaN(minDelay) || minDelay < 0) {
        output.error("Minimum delay must be a non-negative integer");
        process.exit(1);
      }

      let maxDelay: number | undefined;
      if (opts.maxDelay) {
        maxDelay = parseInt(opts.maxDelay);
        if (isNaN(maxDelay) || maxDelay < minDelay) {
          output.error("Maximum delay must be >= minimum delay");
          process.exit(1);
        }
      }

      let admin: PublicKey;
      if (opts.admin) {
        if (!isValidPublicKey(opts.admin)) {
          output.error("Invalid admin address");
          process.exit(1);
        }
        admin = new PublicKey(opts.admin);
      } else {
        admin = provider.wallet.publicKey;
      }

      const timelockConfig = createTimelockConfig(admin, {
        minDelay,
        maxDelay,
      });

      if (!validateTimelockConfig(timelockConfig)) {
        output.error("Invalid configuration");
        process.exit(1);
      }

      if (!config.timelock) {
        config.timelock = {};
      }
      if (!config.timelock[vaultArg]) {
        config.timelock[vaultArg] = {};
      }
      (
        config.timelock[vaultArg] as {
          config?: { admin: string; minDelay: number; maxDelay?: number };
        }
      ).config = {
        admin: timelockConfig.admin.toBase58(),
        minDelay: timelockConfig.minDelay,
        maxDelay: timelockConfig.maxDelay,
      };

      saveConfig(config);

      output.success(`Timelock configured for ${vaultArg}`);
      output.table(
        ["Setting", "Value"],
        [
          ["Minimum Delay", `${minDelay} seconds`],
          ["Maximum Delay", maxDelay ? `${maxDelay} seconds` : "None"],
          ["Admin", admin.toBase58()],
        ],
      );
    });

  timelock
    .command("propose")
    .description("Create a timelocked proposal")
    .argument("<vault>", "Vault address or alias")
    .requiredOption(
      "--action <action>",
      "Action: transfer-authority, update-fees, update-caps, pause, unpause",
    )
    .option("--params <json>", "Action parameters as JSON", "{}")
    .option("--delay <seconds>", "Custom delay (must be >= min-delay)")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const timelockData = config.timelock?.[vaultArg] as
        | {
            config?: {
              admin: string;
              minDelay: number;
              maxDelay?: number;
            };
            proposals?: Record<string, StoredProposal>;
          }
        | undefined;

      if (!timelockData?.config) {
        output.error(`No timelock configured for ${vaultArg}`);
        process.exit(1);
      }

      const validActions = [
        "transfer-authority",
        "update-fees",
        "update-caps",
        "update-access",
        "pause",
        "unpause",
      ];
      const action = opts.action.toLowerCase();
      if (!validActions.includes(action)) {
        output.error(
          `Invalid action. Must be one of: ${validActions.join(", ")}`,
        );
        process.exit(1);
      }

      let params: Record<string, unknown>;
      try {
        params = JSON.parse(opts.params);
      } catch {
        output.error("Invalid JSON for params");
        process.exit(1);
      }

      const minDelay = timelockData.config.minDelay;
      const customDelay = opts.delay ? parseInt(opts.delay) : minDelay;

      if (customDelay < minDelay) {
        output.error(
          `Delay must be >= ${minDelay} seconds (minimum configured)`,
        );
        process.exit(1);
      }

      const now = Math.floor(Date.now() / 1000);
      const proposalId = `${action}-${now}-${Math.random().toString(36).slice(2, 8)}`;

      // Create proposal using SDK
      const timelockConfig = createTimelockConfig(
        new PublicKey(timelockData.config.admin),
        {
          minDelay: timelockData.config.minDelay,
          maxDelay: timelockData.config.maxDelay,
        },
      );

      const proposal = createProposal(
        action as TimelockAction,
        params,
        timelockConfig,
        now,
        customDelay,
      );

      // Store as serializable format
      const storedProposal: StoredProposal = {
        id: proposalId,
        action: action as TimelockAction,
        params,
        proposedAt: now,
        executeAfter: proposal.executeAfter,
        status: ProposalStatus.Pending,
      };

      if (!timelockData.proposals) {
        timelockData.proposals = {};
      }
      timelockData.proposals[proposalId] = storedProposal;
      config.timelock![vaultArg] = timelockData;

      saveConfig(config);

      output.success(`Proposal created: ${proposalId}`);
      output.info("");
      output.table(
        ["Property", "Value"],
        [
          ["ID", proposalId],
          ["Action", action],
          ["ETA", new Date(proposal.executeAfter * 1000).toISOString()],
          ["Delay", `${customDelay} seconds`],
        ],
      );
      output.info("");
      output.info(
        `Execute after ETA with: solana-vault timelock execute ${vaultArg} --proposal-id ${proposalId}`,
      );
    });

  timelock
    .command("execute")
    .description("Execute a ready proposal")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--proposal-id <id>", "Proposal ID to execute")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, options, provider } = ctx;

      const timelockData = config.timelock?.[vaultArg] as
        | {
            config?: { admin: string; minDelay: number; maxDelay?: number };
            proposals?: Record<string, StoredProposal>;
          }
        | undefined;

      if (!timelockData?.proposals?.[opts.proposalId]) {
        output.error(`Proposal ${opts.proposalId} not found`);
        process.exit(1);
      }

      const proposal = timelockData.proposals[opts.proposalId];
      const now = Math.floor(Date.now() / 1000);

      // Check if can execute using SDK types
      const adminKey = timelockData.config?.admin
        ? new PublicKey(timelockData.config.admin)
        : provider.wallet.publicKey;
      const sdkProposal = {
        id: opts.proposalId,
        action: proposal.action,
        params: proposal.params,
        proposer: adminKey,
        proposedAt: proposal.proposedAt,
        executeAfter: proposal.executeAfter,
        expiresAt: proposal.expiresAt ?? proposal.executeAfter + 86400,
        status: proposal.status,
      };

      const executeCheck = canExecute(sdkProposal, now);

      if (!executeCheck.executable) {
        if (proposal.executed) {
          output.error("Proposal already executed");
        } else if (proposal.cancelled) {
          output.error("Proposal was cancelled");
        } else {
          const remaining = proposal.executeAfter - now;
          output.error(`Proposal not ready. ${remaining} seconds remaining.`);
        }
        process.exit(1);
      }

      if (options.dryRun) {
        output.info("DRY RUN - Would execute proposal:");
        output.info(`  Action: ${proposal.action}`);
        output.info(`  Params: ${JSON.stringify(proposal.params)}`);
        return;
      }

      // Mark as executed
      proposal.executed = true;
      proposal.status = ProposalStatus.Executed;
      timelockData.proposals[opts.proposalId] = proposal;
      config.timelock![vaultArg] = timelockData;
      saveConfig(config);

      output.success(`Proposal ${opts.proposalId} marked as executed`);
      output.warn("Note: Actual on-chain execution requires SDK integration");
    });

  timelock
    .command("cancel")
    .description("Cancel a pending proposal")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--proposal-id <id>", "Proposal ID to cancel")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, options } = ctx;

      const timelockData = config.timelock?.[vaultArg] as
        | {
            config?: { admin: string; minDelay: number; maxDelay?: number };
            proposals?: Record<string, StoredProposal>;
          }
        | undefined;

      if (!timelockData?.proposals?.[opts.proposalId]) {
        output.error(`Proposal ${opts.proposalId} not found`);
        process.exit(1);
      }

      const proposal = timelockData.proposals[opts.proposalId];

      if (proposal.executed) {
        output.error("Cannot cancel executed proposal");
        process.exit(1);
      }

      if (proposal.cancelled) {
        output.info("Proposal already cancelled");
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          `Cancel proposal ${opts.proposalId}?`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      proposal.cancelled = true;
      proposal.status = ProposalStatus.Cancelled;
      timelockData.proposals[opts.proposalId] = proposal;
      config.timelock![vaultArg] = timelockData;
      saveConfig(config);

      output.success(`Proposal ${opts.proposalId} cancelled`);
    });

  timelock
    .command("list")
    .description("List all proposals")
    .argument("<vault>", "Vault address or alias")
    .option(
      "--status <status>",
      "Filter by status: pending, ready, executed, cancelled",
    )
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const timelockData = config.timelock?.[vaultArg] as
        | {
            proposals?: Record<string, StoredProposal>;
          }
        | undefined;

      const proposals = Object.values(timelockData?.proposals ?? {});

      if (proposals.length === 0) {
        output.info(`No proposals for ${vaultArg}`);
        return;
      }

      const now = Math.floor(Date.now() / 1000);

      let filtered = proposals;
      if (opts.status) {
        const statusFilter = opts.status.toLowerCase();
        filtered = proposals.filter((p) => {
          const currentStatus = p.executed
            ? "executed"
            : p.cancelled
              ? "cancelled"
              : p.executeAfter <= now
                ? "ready"
                : "pending";
          return currentStatus === statusFilter;
        });
      }

      if (globalOpts.output === "json") {
        output.json({ vault: vaultArg, proposals: filtered });
        return;
      }

      if (filtered.length === 0) {
        output.info(`No proposals matching filter`);
        return;
      }

      output.info(`Proposals for ${vaultArg}\n`);
      const rows: [string, string, string, string][] = filtered.map((p) => {
        const status = p.executed
          ? ProposalStatus.Executed
          : p.cancelled
            ? ProposalStatus.Cancelled
            : p.executeAfter <= now
              ? ProposalStatus.Ready
              : ProposalStatus.Pending;
        const eta = new Date(p.executeAfter * 1000).toISOString().slice(0, 19);
        return [p.id.slice(0, 12) + "...", p.action, status, eta];
      });

      output.table(["ID", "Action", "Status", "ETA"], rows);
    });

  timelock
    .command("clear")
    .description("Clear all timelock data")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config, options } = ctx;

      if (!config.timelock?.[vaultArg]) {
        output.info(`No timelock data for ${vaultArg}`);
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          `Clear all timelock data for ${vaultArg}?`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      delete config.timelock[vaultArg];
      saveConfig(config);

      output.success(`Timelock data cleared for ${vaultArg}`);
    });
}
