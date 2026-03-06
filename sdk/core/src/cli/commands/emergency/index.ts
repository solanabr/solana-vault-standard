/** Emergency Commands - Emergency withdrawal configuration and execution */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVaultArg, saveConfig, isValidPublicKey } from "../../utils";
import {
  EmergencyConfig,
  previewEmergencyRedeem,
  createEmergencyConfig,
  validateEmergencyConfig,
} from "../../../emergency";

const MAX_PENALTY_BPS = 5000; // 50% max penalty

export function registerEmergencyCommands(program: Command): void {
  const emergency = program
    .command("emergency")
    .description("Emergency withdrawal configuration and execution");

  emergency
    .command("show")
    .description("Show emergency withdrawal configuration and status")
    .argument("<vault>", "Vault address or alias")
    .option("--user-shares <amount>", "User's share balance for status calc")
    .option("--total-assets <amount>", "Current total assets")
    .option("--total-shares <amount>", "Current total shares")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const storedEmergency = config.emergency?.[vaultArg] as
        | {
            penaltyBps: number;
            cooldownPeriod?: number;
            penaltyRecipient?: string;
            minPenalty?: string;
            maxPenalty?: string;
          }
        | undefined;

      if (!storedEmergency) {
        output.info(`No emergency configuration for ${vaultArg}`);
        output.info("");
        output.info("Configure emergency withdrawal with:");
        output.info(
          `  solana-vault emergency configure ${vaultArg} --penalty 500 --cooldown 3600`,
        );
        return;
      }

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          emergency: {
            penaltyBps: storedEmergency.penaltyBps,
            cooldownPeriod: storedEmergency.cooldownPeriod,
            penaltyRecipient: storedEmergency.penaltyRecipient,
          },
        });
        return;
      }

      output.info(`Emergency Withdrawal Configuration for ${vaultArg}\n`);

      const rows: [string, string][] = [
        [
          "Penalty",
          `${storedEmergency.penaltyBps} bps (${(storedEmergency.penaltyBps / 100).toFixed(2)}%)`,
        ],
        ["Cooldown", `${storedEmergency.cooldownPeriod ?? 0} seconds`],
      ];

      if (storedEmergency.penaltyRecipient) {
        rows.push(["Penalty Recipient", storedEmergency.penaltyRecipient]);
      }

      output.table(["Setting", "Value"], rows);
    });

  emergency
    .command("configure")
    .description("Configure emergency withdrawal settings")
    .argument("<vault>", "Vault address or alias")
    .option("--penalty <bps>", "Penalty in basis points (0-5000)")
    .option("--cooldown <seconds>", "Cooldown period between withdrawals")
    .option("--recipient <pubkey>", "Penalty recipient address")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const existing = config.emergency?.[vaultArg] as
        | {
            penaltyBps?: number;
            cooldownPeriod?: number;
            penaltyRecipient?: string;
          }
        | undefined;

      // Parse and validate penalty
      let penaltyBps = existing?.penaltyBps ?? 0;
      if (opts.penalty !== undefined) {
        penaltyBps = parseInt(opts.penalty);
        if (
          isNaN(penaltyBps) ||
          penaltyBps < 0 ||
          penaltyBps > MAX_PENALTY_BPS
        ) {
          output.error(
            `Penalty must be between 0 and ${MAX_PENALTY_BPS} basis points`,
          );
          process.exit(1);
        }
      }

      // Parse cooldown
      let cooldownPeriod = existing?.cooldownPeriod ?? 0;
      if (opts.cooldown !== undefined) {
        cooldownPeriod = parseInt(opts.cooldown);
        if (isNaN(cooldownPeriod) || cooldownPeriod < 0) {
          output.error("Cooldown must be a non-negative integer");
          process.exit(1);
        }
      }

      // Parse penalty recipient
      let penaltyRecipient: PublicKey;
      if (opts.recipient) {
        if (!isValidPublicKey(opts.recipient)) {
          output.error("Invalid penalty recipient address");
          process.exit(1);
        }
        penaltyRecipient = new PublicKey(opts.recipient);
      } else if (existing?.penaltyRecipient) {
        penaltyRecipient = new PublicKey(existing.penaltyRecipient);
      } else {
        // Default to wallet's public key
        penaltyRecipient = provider.wallet.publicKey;
      }

      const newConfig = createEmergencyConfig(penaltyBps, penaltyRecipient, {
        cooldownPeriod,
      });

      if (!validateEmergencyConfig(newConfig)) {
        output.error("Invalid configuration");
        process.exit(1);
      }

      if (!config.emergency) {
        config.emergency = {};
      }
      config.emergency[vaultArg] = {
        penaltyBps: newConfig.penaltyBps,
        cooldownPeriod: newConfig.cooldownPeriod,
        penaltyRecipient: newConfig.penaltyRecipient.toBase58(),
        minPenalty: newConfig.minPenalty.toString(),
        maxPenalty: newConfig.maxPenalty.toString(),
      };

      saveConfig(config);

      output.success(`Emergency configuration saved for ${vaultArg}`);

      if (globalOpts.output !== "json") {
        output.info("");
        output.table(
          ["Setting", "Value"],
          [
            ["Penalty", `${newConfig.penaltyBps} bps`],
            ["Cooldown", `${newConfig.cooldownPeriod}s`],
            ["Recipient", newConfig.penaltyRecipient.toBase58()],
          ],
        );
      }
    });

  emergency
    .command("preview")
    .description("Preview emergency withdrawal penalty and output")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--shares <amount>", "Shares to redeem")
    .option("--total-assets <amount>", "Current total assets", "1000000000")
    .option("--total-shares <amount>", "Current total shares", "1000000000")
    .option("--decimals-offset <number>", "Decimals offset", "6")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

      const storedEmergency = config.emergency?.[vaultArg] as
        | {
            penaltyBps: number;
            cooldownPeriod?: number;
            penaltyRecipient?: string;
            minPenalty?: string;
            maxPenalty?: string;
          }
        | undefined;

      if (!storedEmergency) {
        output.error(`No emergency configuration for ${vaultArg}`);
        process.exit(1);
      }

      const shares = new BN(opts.shares);
      const totalAssets = new BN(opts.totalAssets);
      const totalShares = new BN(opts.totalShares);
      const decimalsOffset = parseInt(opts.decimalsOffset);

      const fullConfig: EmergencyConfig = {
        penaltyBps: storedEmergency.penaltyBps,
        cooldownPeriod: storedEmergency.cooldownPeriod ?? 0,
        penaltyRecipient: storedEmergency.penaltyRecipient
          ? new PublicKey(storedEmergency.penaltyRecipient)
          : provider.wallet.publicKey,
        minPenalty: storedEmergency.minPenalty
          ? new BN(storedEmergency.minPenalty)
          : new BN(0),
        maxPenalty: storedEmergency.maxPenalty
          ? new BN(storedEmergency.maxPenalty)
          : new BN("18446744073709551615"),
      };

      const result = previewEmergencyRedeem(
        shares,
        totalAssets,
        totalShares,
        decimalsOffset,
        fullConfig,
      );

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          shares: opts.shares,
          preview: {
            grossAssets: result.grossAssets.toString(),
            penalty: result.penalty.toString(),
            netAssets: result.netAssets.toString(),
          },
        });
        return;
      }

      output.info(`Emergency Withdrawal Preview for ${vaultArg}\n`);
      output.table(
        ["Item", "Amount"],
        [
          ["Shares to Redeem", shares.toString()],
          ["Gross Assets", result.grossAssets.toString()],
          ["Penalty Amount", result.penalty.toString()],
          ["Net Assets", result.netAssets.toString()],
          ["Penalty %", `${(storedEmergency.penaltyBps / 100).toFixed(2)}%`],
        ],
      );
    });

  emergency
    .command("withdraw")
    .description("Execute emergency withdrawal (when vault is paused)")
    .argument("<vault>", "Vault address or alias")
    .option("--shares <amount>", "Shares to redeem (default: all)")
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, options } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const storedEmergency = config.emergency?.[vaultArg] as
        | {
            penaltyBps: number;
          }
        | undefined;

      if (!storedEmergency) {
        output.error(`No emergency configuration for ${vaultArg}`);
        output.info("Configure first with: solana-vault emergency configure");
        process.exit(1);
      }

      output.warn("Emergency withdrawal incurs a penalty!");
      output.info(
        `Penalty: ${storedEmergency.penaltyBps} bps (${(storedEmergency.penaltyBps / 100).toFixed(2)}%)`,
      );

      if (options.dryRun) {
        output.info("");
        output.info("DRY RUN - Would execute emergency withdrawal:");
        output.info(`  Variant: ${resolved.variant.toUpperCase()}`);
        output.info(`  Shares: ${opts.shares ?? "all"}`);
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          "Execute emergency withdrawal with penalty?",
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      output.error(
        "Emergency withdrawal execution not yet implemented in programs",
      );
      output.info("Use SDK directly for emergency operations");
    });

  emergency
    .command("clear")
    .description("Clear emergency configuration")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config, options } = ctx;

      if (!config.emergency?.[vaultArg]) {
        output.info(`No emergency configuration for ${vaultArg}`);
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          `Clear emergency configuration for ${vaultArg}?`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      delete config.emergency[vaultArg];
      saveConfig(config);

      output.success(`Emergency configuration cleared for ${vaultArg}`);
    });
}
