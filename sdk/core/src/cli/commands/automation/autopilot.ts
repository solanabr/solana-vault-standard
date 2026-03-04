/** Autopilot Command - Configure automated vault operations (sync, fees) */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { ManagedVault } from "../../../managed-vault";
import { findIdlPath, loadIdl, resolveVaultArg, saveConfig } from "../../utils";

interface AutopilotConfig {
  sync?: {
    enabled: boolean;
    interval: string;
    lastRun?: string;
  };
  fees?: {
    enabled: boolean;
    threshold: string;
    lastRun?: string;
  };
  healthCheck?: {
    enabled: boolean;
    interval: string;
    alertWebhook?: string;
    lastRun?: string;
  };
}

export function registerAutopilotCommand(program: Command): void {
  const autopilot = program
    .command("autopilot")
    .description("Configure automated vault operations");

  autopilot
    .command("show")
    .description("Show autopilot configuration")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config } = ctx;

      const autopilotConfig = config.autopilot?.[vaultArg];

      if (!autopilotConfig) {
        output.info(`No autopilot configuration for ${vaultArg}`);
        output.info(
          `\nSet up autopilot with: solana-vault autopilot configure ${vaultArg}`,
        );
        return;
      }

      if (globalOpts.output === "json") {
        output.json({ vault: vaultArg, autopilot: autopilotConfig });
        return;
      }

      output.info(`Autopilot configuration for ${vaultArg}\n`);

      if (autopilotConfig.sync) {
        output.info("SYNC");
        output.info(
          `  Enabled:  ${autopilotConfig.sync.enabled ? "Yes" : "No"}`,
        );
        output.info(`  Interval: ${autopilotConfig.sync.interval}`);
        if (autopilotConfig.sync.lastRun) {
          output.info(`  Last run: ${autopilotConfig.sync.lastRun}`);
        }
      }

      if (autopilotConfig.fees) {
        output.info("");
        output.info("FEE COLLECTION");
        output.info(
          `  Enabled:   ${autopilotConfig.fees.enabled ? "Yes" : "No"}`,
        );
        output.info(`  Threshold: ${autopilotConfig.fees.threshold}`);
        if (autopilotConfig.fees.lastRun) {
          output.info(`  Last run:  ${autopilotConfig.fees.lastRun}`);
        }
      }

      if (autopilotConfig.healthCheck) {
        output.info("");
        output.info("HEALTH CHECK");
        output.info(
          `  Enabled:  ${autopilotConfig.healthCheck.enabled ? "Yes" : "No"}`,
        );
        output.info(`  Interval: ${autopilotConfig.healthCheck.interval}`);
        if (autopilotConfig.healthCheck.alertWebhook) {
          output.info(
            `  Webhook:  ${autopilotConfig.healthCheck.alertWebhook.substring(0, 30)}...`,
          );
        }
        if (autopilotConfig.healthCheck.lastRun) {
          output.info(`  Last run: ${autopilotConfig.healthCheck.lastRun}`);
        }
      }
    });

  autopilot
    .command("configure")
    .description("Configure autopilot settings")
    .argument("<vault>", "Vault address or alias")
    .option("--enable-sync", "Enable automatic balance sync")
    .option("--disable-sync", "Disable automatic balance sync")
    .option("--sync-interval <interval>", "Sync interval (e.g., 1h, 30m, 1d)")
    .option("--enable-fees", "Enable automatic fee collection")
    .option("--disable-fees", "Disable automatic fee collection")
    .option("--fee-threshold <amount>", "Minimum fees to trigger collection")
    .option("--enable-health", "Enable health monitoring")
    .option("--disable-health", "Disable health monitoring")
    .option("--health-interval <interval>", "Health check interval")
    .option("--alert-webhook <url>", "Webhook URL for health alerts")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const existingConfig = config.autopilot?.[vaultArg] || {};
      const newConfig: AutopilotConfig = { ...existingConfig };

      if (opts.enableSync || opts.syncInterval) {
        newConfig.sync = newConfig.sync || { enabled: false, interval: "1h" };
        if (opts.enableSync) newConfig.sync.enabled = true;
        if (opts.syncInterval) newConfig.sync.interval = opts.syncInterval;
      }
      if (opts.disableSync && newConfig.sync) {
        newConfig.sync.enabled = false;
      }

      if (opts.enableFees || opts.feeThreshold) {
        newConfig.fees = newConfig.fees || {
          enabled: false,
          threshold: "1000000",
        };
        if (opts.enableFees) newConfig.fees.enabled = true;
        if (opts.feeThreshold) newConfig.fees.threshold = opts.feeThreshold;
      }
      if (opts.disableFees && newConfig.fees) {
        newConfig.fees.enabled = false;
      }

      if (opts.enableHealth || opts.healthInterval || opts.alertWebhook) {
        newConfig.healthCheck = newConfig.healthCheck || {
          enabled: false,
          interval: "5m",
        };
        if (opts.enableHealth) newConfig.healthCheck.enabled = true;
        if (opts.healthInterval)
          newConfig.healthCheck.interval = opts.healthInterval;
        if (opts.alertWebhook)
          newConfig.healthCheck.alertWebhook = opts.alertWebhook;
      }
      if (opts.disableHealth && newConfig.healthCheck) {
        newConfig.healthCheck.enabled = false;
      }

      if (!config.autopilot) {
        config.autopilot = {};
      }
      config.autopilot[vaultArg] = newConfig;

      saveConfig(config);

      output.success(`Autopilot configuration saved for ${vaultArg}`);

      if (globalOpts.output === "json") {
        output.json({ vault: vaultArg, autopilot: newConfig });
      }
    });

  autopilot
    .command("run")
    .description("Run autopilot tasks for a vault")
    .argument("<vault>", "Vault address or alias")
    .option("--sync-only", "Only run sync task")
    .option("--fees-only", "Only run fee collection")
    .option("--health-only", "Only run health check")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, connection, provider, wallet, options } = ctx;

      const autopilotConfig = config.autopilot?.[vaultArg];

      if (!autopilotConfig) {
        output.error(`No autopilot configuration for ${vaultArg}`);
        output.info(
          `Set up autopilot with: solana-vault autopilot configure ${vaultArg}`,
        );
        process.exit(1);
      }

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);
      const variant = resolved.variant;

      const results: { task: string; status: string; details?: string }[] = [];

      if (
        autopilotConfig.sync?.enabled &&
        !opts.feesOnly &&
        !opts.healthOnly &&
        (variant === "svs-2" || variant === "svs-4")
      ) {
        output.info("Running sync task...");
        try {
          const idlPath = findIdlPath(variant);
          if (!idlPath) throw new Error(`IDL for ${variant} not found`);

          const idl = loadIdl(idlPath);
          const prog = new Program(idl as any, provider);
          const vault = await ManagedVault.load(
            prog,
            resolved.assetMint,
            resolved.vaultId,
          );
          const state = await vault.getState();

          if (!state.authority.equals(wallet.publicKey)) {
            results.push({
              task: "sync",
              status: "skipped",
              details: "Not vault authority",
            });
          } else {
            const storedBalance = await vault.storedTotalAssets();
            const assetVaultAccount = await getAccount(
              connection,
              state.assetVault,
            );
            const liveBalance = new BN(assetVaultAccount.amount.toString());

            if (!storedBalance.eq(liveBalance)) {
              if (!options.dryRun) {
                const sig = await vault.sync(wallet.publicKey);
                results.push({
                  task: "sync",
                  status: "success",
                  details: `Synced. Sig: ${sig.substring(0, 20)}...`,
                });
              } else {
                results.push({
                  task: "sync",
                  status: "dry-run",
                  details: `Would sync ${liveBalance.sub(storedBalance).toString()}`,
                });
              }
            } else {
              results.push({
                task: "sync",
                status: "skipped",
                details: "Already in sync",
              });
            }
          }
        } catch (error) {
          results.push({
            task: "sync",
            status: "error",
            details: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (
        autopilotConfig.healthCheck?.enabled &&
        !opts.syncOnly &&
        !opts.feesOnly
      ) {
        output.info("Running health check...");
        try {
          const accountInfo = await connection.getAccountInfo(
            resolved.programId,
          );
          if (accountInfo) {
            results.push({
              task: "health",
              status: "success",
              details: "Vault program healthy",
            });
          } else {
            results.push({
              task: "health",
              status: "warning",
              details: "Program not found on-chain",
            });
          }
        } catch (error) {
          results.push({
            task: "health",
            status: "error",
            details: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const now = new Date().toISOString();
      if (autopilotConfig.sync && results.some((r) => r.task === "sync")) {
        autopilotConfig.sync.lastRun = now;
      }
      if (
        autopilotConfig.healthCheck &&
        results.some((r) => r.task === "health")
      ) {
        autopilotConfig.healthCheck.lastRun = now;
      }

      saveConfig(config);

      if (globalOpts.output === "json") {
        output.json({ vault: vaultArg, results });
        return;
      }

      output.info("");
      output.info("Autopilot results:");
      output.table(
        ["Task", "Status", "Details"],
        results.map((r) => [r.task, r.status, r.details || "-"]),
      );
    });

  autopilot
    .command("clear")
    .description("Clear autopilot configuration")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config, options } = ctx;

      if (!config.autopilot?.[vaultArg]) {
        output.info(`No autopilot configuration for ${vaultArg}`);
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          `Clear autopilot settings for ${vaultArg}?`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      delete config.autopilot[vaultArg];

      saveConfig(config);

      output.success(`Autopilot configuration cleared for ${vaultArg}`);
    });
}
