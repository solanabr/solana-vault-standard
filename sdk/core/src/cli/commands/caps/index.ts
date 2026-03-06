/** Cap Commands - View and manage deposit cap configuration */

import { Command } from "commander";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVaultArg, saveConfig } from "../../utils";
import {
  CapConfig,
  checkDepositCap,
  maxDeposit,
  getCapStatus,
  validateCapConfig,
  createCapConfig,
  createDisabledCapConfig,
} from "../../../cap";

export function registerCapsCommands(program: Command): void {
  const cap = program
    .command("cap")
    .description("View and manage deposit cap configuration");

  cap
    .command("show")
    .description("Display current cap configuration and utilization")
    .argument("<vault>", "Vault address or alias")
    .option(
      "--total-assets <amount>",
      "Current total assets for utilization calc",
    )
    .option("--user-deposit <amount>", "Current user deposit amount")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const storedCap = config.caps?.[vaultArg] as
        | {
            enabled: boolean;
            globalCap?: string;
            perUserCap?: string;
          }
        | undefined;

      if (!storedCap || !storedCap.enabled) {
        output.info(`No deposit caps configured for ${vaultArg}`);
        output.info("");
        output.info("Configure caps with:");
        output.info(
          `  solana-vault cap configure ${vaultArg} --global 1000000000 --per-user 10000000`,
        );
        return;
      }

      // Convert stored string values to CapConfig
      const capConfig: CapConfig = {
        enabled: storedCap.enabled,
        globalCap: storedCap.globalCap ? new BN(storedCap.globalCap) : null,
        perUserCap: storedCap.perUserCap ? new BN(storedCap.perUserCap) : null,
      };

      const totalAssets = opts.totalAssets
        ? new BN(opts.totalAssets)
        : new BN(0);
      const userDeposit = opts.userDeposit
        ? new BN(opts.userDeposit)
        : new BN(0);

      const status = getCapStatus(totalAssets, userDeposit, capConfig);

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          caps: {
            enabled: capConfig.enabled,
            globalCap: capConfig.globalCap?.toString(),
            perUserCap: capConfig.perUserCap?.toString(),
          },
          status: {
            globalUtilization: status.globalUtilization,
            userUtilization: status.userUtilization,
            globalRemaining: status.globalRemaining?.toString(),
            userRemaining: status.userRemaining?.toString(),
          },
        });
        return;
      }

      output.info(`Deposit Cap Configuration for ${vaultArg}\n`);

      const rows: [string, string][] = [
        ["Status", capConfig.enabled ? "Enabled" : "Disabled"],
      ];

      if (capConfig.globalCap) {
        rows.push(["Global Cap", capConfig.globalCap.toString()]);
        rows.push([
          "Global Utilization",
          `${status.globalUtilization.toFixed(2)}%`,
        ]);
        rows.push(["Global Remaining", status.globalRemaining.toString()]);
      }

      if (capConfig.perUserCap) {
        rows.push(["Per-User Cap", capConfig.perUserCap.toString()]);
        rows.push([
          "User Utilization",
          `${status.userUtilization.toFixed(2)}%`,
        ]);
        rows.push(["User Remaining", status.userRemaining.toString()]);
      }

      output.table(["Property", "Value"], rows);
    });

  cap
    .command("configure")
    .description("Configure deposit caps for a vault")
    .argument("<vault>", "Vault address or alias")
    .option("--global <amount>", "Global deposit cap (total assets limit)")
    .option("--per-user <amount>", "Per-user deposit cap")
    .option("--disable", "Disable all caps")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      let newCapConfig: CapConfig;

      if (opts.disable) {
        newCapConfig = createDisabledCapConfig();
      } else {
        const globalCap = opts.global ? new BN(opts.global) : null;
        const perUserCap = opts.perUser ? new BN(opts.perUser) : null;

        if (!globalCap && !perUserCap) {
          output.error("Specify --global and/or --per-user, or use --disable");
          process.exit(1);
        }

        newCapConfig = createCapConfig(globalCap, perUserCap);
      }

      if (!validateCapConfig(newCapConfig)) {
        output.error("Invalid cap configuration");
        process.exit(1);
      }

      if (!config.caps) {
        config.caps = {};
      }
      config.caps[vaultArg] = {
        enabled: newCapConfig.enabled,
        globalCap: newCapConfig.globalCap?.toString(),
        perUserCap: newCapConfig.perUserCap?.toString(),
      };

      saveConfig(config);

      output.success(`Cap configuration saved for ${vaultArg}`);

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          caps: {
            enabled: newCapConfig.enabled,
            globalCap: newCapConfig.globalCap?.toString(),
            perUserCap: newCapConfig.perUserCap?.toString(),
          },
        });
      } else if (newCapConfig.enabled) {
        output.info("");
        output.table(
          ["Cap Type", "Value"],
          [
            ["Global Cap", newCapConfig.globalCap?.toString() ?? "None"],
            ["Per-User Cap", newCapConfig.perUserCap?.toString() ?? "None"],
          ],
        );
      }
    });

  cap
    .command("check")
    .description("Check if a deposit amount would be allowed")
    .argument("<vault>", "Vault address or alias")
    .argument("<amount>", "Deposit amount to check")
    .option("--total-assets <amount>", "Current total assets", "0")
    .option("--user-deposit <amount>", "Current user deposit amount", "0")
    .action(async (vaultArg, amountStr, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const storedCap = config.caps?.[vaultArg] as
        | {
            enabled: boolean;
            globalCap?: string;
            perUserCap?: string;
          }
        | undefined;

      if (!storedCap || !storedCap.enabled) {
        output.success("No caps configured - deposit would be allowed");
        return;
      }

      const depositAmount = new BN(amountStr);
      const totalAssets = new BN(opts.totalAssets);
      const userDeposit = new BN(opts.userDeposit);

      // Convert stored string values back to CapConfig
      const capConfig: CapConfig = {
        enabled: storedCap.enabled,
        globalCap: storedCap.globalCap ? new BN(storedCap.globalCap) : null,
        perUserCap: storedCap.perUserCap ? new BN(storedCap.perUserCap) : null,
      };

      const result = checkDepositCap(
        depositAmount,
        totalAssets,
        userDeposit,
        capConfig,
      );

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          amount: amountStr,
          allowed: result.allowed,
          maxAllowedDeposit: result.maxAllowedDeposit.toString(),
          reason: result.reason,
        });
        return;
      }

      if (result.allowed) {
        output.success(`Deposit of ${amountStr} would be allowed`);
      } else {
        output.error(`Deposit of ${amountStr} would be blocked`);
        if (result.reason) {
          output.info(`Reason: ${result.reason}`);
        }
        output.info("");
        output.info(`Maximum allowed: ${result.maxAllowedDeposit.toString()}`);
      }
    });

  cap
    .command("max")
    .description("Get maximum deposit allowed")
    .argument("<vault>", "Vault address or alias")
    .option("--total-assets <amount>", "Current total assets", "0")
    .option("--user-deposit <amount>", "Current user deposit amount", "0")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const storedCap = config.caps?.[vaultArg] as
        | {
            enabled: boolean;
            globalCap?: string;
            perUserCap?: string;
          }
        | undefined;

      if (!storedCap || !storedCap.enabled) {
        output.info("No caps configured - unlimited deposits allowed");
        return;
      }

      const totalAssets = new BN(opts.totalAssets);
      const userDeposit = new BN(opts.userDeposit);

      const capConfig: CapConfig = {
        enabled: storedCap.enabled,
        globalCap: storedCap.globalCap ? new BN(storedCap.globalCap) : null,
        perUserCap: storedCap.perUserCap ? new BN(storedCap.perUserCap) : null,
      };

      const max = maxDeposit(totalAssets, userDeposit, capConfig);

      if (globalOpts.output === "json") {
        output.json({ vault: vaultArg, maxDeposit: max.toString() });
      } else {
        output.info(`Maximum deposit allowed: ${max.toString()}`);
      }
    });

  cap
    .command("clear")
    .description("Clear cap configuration (disable all caps)")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config, options } = ctx;

      if (!config.caps?.[vaultArg]) {
        output.info(`No cap configuration for ${vaultArg}`);
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          `Clear cap configuration for ${vaultArg}?`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      delete config.caps[vaultArg];
      saveConfig(config);

      output.success(`Cap configuration cleared for ${vaultArg}`);
    });
}
