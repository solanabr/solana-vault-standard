/** Guard Command - Configure safety rails and transaction limits */

import { Command } from "commander";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { getConfigPath, saveConfig } from "../../utils";

interface GuardConfig {
  maxDepositPerTx?: string;
  maxWithdrawPerTx?: string;
  dailyDepositLimit?: string;
  dailyWithdrawLimit?: string;
  cooldownSeconds?: number;
  pauseOnAnomaly?: boolean;
  anomalyThresholds?: {
    priceChangePercent?: number;
    volumeSpike?: number;
  };
}

export function registerGuardCommand(program: Command): void {
  const guard = program
    .command("guard")
    .description("Configure safety rails and limits for vault operations");

  guard
    .command("show")
    .description("Show current guard configuration")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config } = ctx;

      const guardConfig = config.guards?.[vaultArg];

      if (!guardConfig) {
        output.info(`No guard configuration for ${vaultArg}`);
        output.info(
          `\nSet up guards with: solana-vault guard configure ${vaultArg}`,
        );
        return;
      }

      if (globalOpts.output === "json") {
        output.json({ vault: vaultArg, guard: guardConfig });
        return;
      }

      output.info(`Guard configuration for ${vaultArg}\n`);

      const rows: [string, string][] = [];

      if (guardConfig.maxDepositPerTx) {
        rows.push(["Max Deposit/Tx", guardConfig.maxDepositPerTx]);
      }
      if (guardConfig.maxWithdrawPerTx) {
        rows.push(["Max Withdraw/Tx", guardConfig.maxWithdrawPerTx]);
      }
      if (guardConfig.dailyDepositLimit) {
        rows.push(["Daily Deposit Limit", guardConfig.dailyDepositLimit]);
      }
      if (guardConfig.dailyWithdrawLimit) {
        rows.push(["Daily Withdraw Limit", guardConfig.dailyWithdrawLimit]);
      }
      if (guardConfig.cooldownSeconds !== undefined) {
        rows.push(["Cooldown", `${guardConfig.cooldownSeconds}s`]);
      }
      if (guardConfig.pauseOnAnomaly !== undefined) {
        rows.push([
          "Pause on Anomaly",
          guardConfig.pauseOnAnomaly ? "Yes" : "No",
        ]);
      }
      if (guardConfig.anomalyThresholds) {
        if (guardConfig.anomalyThresholds.priceChangePercent !== undefined) {
          rows.push([
            "Price Change Threshold",
            `${guardConfig.anomalyThresholds.priceChangePercent}%`,
          ]);
        }
        if (guardConfig.anomalyThresholds.volumeSpike !== undefined) {
          rows.push([
            "Volume Spike Threshold",
            `${guardConfig.anomalyThresholds.volumeSpike}x`,
          ]);
        }
      }

      if (rows.length === 0) {
        output.info("No limits configured.");
      } else {
        output.table(["Setting", "Value"], rows);
      }
    });

  guard
    .command("configure")
    .description("Configure guard settings interactively")
    .argument("<vault>", "Vault address or alias")
    .option("--max-deposit <amount>", "Maximum deposit per transaction")
    .option("--max-withdraw <amount>", "Maximum withdraw per transaction")
    .option("--daily-deposit <amount>", "Daily deposit limit")
    .option("--daily-withdraw <amount>", "Daily withdraw limit")
    .option("--cooldown <seconds>", "Cooldown between operations (seconds)")
    .option("--pause-on-anomaly", "Auto-pause vault on anomaly detection")
    .option("--price-threshold <percent>", "Price change % to trigger anomaly")
    .option(
      "--volume-threshold <multiplier>",
      "Volume spike multiplier for anomaly",
    )
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const existingGuard = config.guards?.[vaultArg] || {};
      const newGuard: GuardConfig = { ...existingGuard };

      if (opts.maxDeposit) {
        newGuard.maxDepositPerTx = opts.maxDeposit;
      }
      if (opts.maxWithdraw) {
        newGuard.maxWithdrawPerTx = opts.maxWithdraw;
      }
      if (opts.dailyDeposit) {
        newGuard.dailyDepositLimit = opts.dailyDeposit;
      }
      if (opts.dailyWithdraw) {
        newGuard.dailyWithdrawLimit = opts.dailyWithdraw;
      }
      if (opts.cooldown) {
        newGuard.cooldownSeconds = parseInt(opts.cooldown);
      }
      if (opts.pauseOnAnomaly) {
        newGuard.pauseOnAnomaly = true;
      }
      if (opts.priceThreshold || opts.volumeThreshold) {
        newGuard.anomalyThresholds = newGuard.anomalyThresholds || {};
        if (opts.priceThreshold) {
          newGuard.anomalyThresholds.priceChangePercent = parseFloat(
            opts.priceThreshold,
          );
        }
        if (opts.volumeThreshold) {
          newGuard.anomalyThresholds.volumeSpike = parseFloat(
            opts.volumeThreshold,
          );
        }
      }

      if (!config.guards) {
        config.guards = {};
      }
      config.guards[vaultArg] = newGuard;

      saveConfig(config);

      output.success(`Guard configuration saved for ${vaultArg}`);

      if (globalOpts.output === "json") {
        output.json({ vault: vaultArg, guard: newGuard });
      } else {
        const rows: [string, string][] = [];
        if (newGuard.maxDepositPerTx)
          rows.push(["Max Deposit/Tx", newGuard.maxDepositPerTx]);
        if (newGuard.maxWithdrawPerTx)
          rows.push(["Max Withdraw/Tx", newGuard.maxWithdrawPerTx]);
        if (newGuard.dailyDepositLimit)
          rows.push(["Daily Deposit Limit", newGuard.dailyDepositLimit]);
        if (newGuard.dailyWithdrawLimit)
          rows.push(["Daily Withdraw Limit", newGuard.dailyWithdrawLimit]);
        if (newGuard.cooldownSeconds !== undefined)
          rows.push(["Cooldown", `${newGuard.cooldownSeconds}s`]);
        if (rows.length > 0) {
          output.table(["Setting", "Value"], rows);
        }
      }
    });

  guard
    .command("clear")
    .description("Clear guard configuration for a vault")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config, options } = ctx;

      if (!config.guards?.[vaultArg]) {
        output.info(`No guard configuration for ${vaultArg}`);
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          `Clear all guard settings for ${vaultArg}?`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      delete config.guards[vaultArg];

      saveConfig(config);

      output.success(`Guard configuration cleared for ${vaultArg}`);
    });

  guard
    .command("check")
    .description("Check if an operation would pass guard limits")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--operation <type>", "Operation type (deposit/withdraw)")
    .requiredOption("--amount <amount>", "Amount to check")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const guardConfig = config.guards?.[vaultArg];
      const amount = new BN(opts.amount);
      const operation = opts.operation.toLowerCase();

      if (!guardConfig) {
        output.success(`No guards configured - operation would be allowed`);
        return;
      }

      const issues: string[] = [];

      if (operation === "deposit") {
        if (guardConfig.maxDepositPerTx) {
          const max = new BN(guardConfig.maxDepositPerTx);
          if (amount.gt(max)) {
            issues.push(
              `Exceeds max deposit per tx (${guardConfig.maxDepositPerTx})`,
            );
          }
        }
      } else if (operation === "withdraw") {
        if (guardConfig.maxWithdrawPerTx) {
          const max = new BN(guardConfig.maxWithdrawPerTx);
          if (amount.gt(max)) {
            issues.push(
              `Exceeds max withdraw per tx (${guardConfig.maxWithdrawPerTx})`,
            );
          }
        }
      }

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          operation,
          amount: opts.amount,
          allowed: issues.length === 0,
          issues,
        });
        return;
      }

      if (issues.length === 0) {
        output.success(`Operation would be allowed by guard configuration`);
      } else {
        output.error(`Operation would be blocked:`);
        for (const issue of issues) {
          output.info(`  • ${issue}`);
        }
      }
    });
}
