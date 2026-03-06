/** Portfolio Commands - Multi-vault portfolio management */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { saveConfig, isValidPublicKey } from "../../utils";
import {
  MultiVaultConfig,
  VaultAllocation,
  validateWeights,
  allocateDeposit,
  allocateRedemption,
  needsRebalance,
  calculateRebalanceOps,
  getMultiVaultState,
  createMultiVaultConfig,
  validateMultiVaultConfig,
  calculateCurrentWeights,
} from "../../../multi-asset";

export function registerPortfolioCommands(program: Command): void {
  const portfolio = program
    .command("portfolio")
    .description("Multi-vault portfolio management");

  portfolio
    .command("show")
    .description("Show configured multi-vault portfolio")
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config } = ctx;

      const portfolioConfig = config.portfolio as
        | {
            allocations?: Array<{
              vault: string;
              targetWeightBps: number;
              name?: string;
            }>;
            rebalanceThresholdBps?: number;
          }
        | undefined;

      if (
        !portfolioConfig?.allocations ||
        portfolioConfig.allocations.length === 0
      ) {
        output.info("No portfolio configured");
        output.info("");
        output.info("Configure a portfolio with:");
        output.info(
          '  solana-vault portfolio configure --allocations \'[{"vault":"my-vault","targetWeightBps":5000}]\'',
        );
        return;
      }

      if (globalOpts.output === "json") {
        output.json({ portfolio: portfolioConfig });
        return;
      }

      output.info("Portfolio Configuration\n");

      const rows: [string, string, string][] = portfolioConfig.allocations.map(
        (a) => {
          const name = a.name ?? a.vault;
          return [name, a.vault, `${a.targetWeightBps / 100}%`];
        },
      );

      output.table(["Name", "Vault", "Target Weight"], rows);

      const totalWeight = portfolioConfig.allocations.reduce(
        (sum, a) => sum + a.targetWeightBps,
        0,
      );
      output.info("");
      output.info(`Total allocation: ${totalWeight / 100}%`);

      if (portfolioConfig.rebalanceThresholdBps) {
        output.info(
          `Rebalance threshold: ${portfolioConfig.rebalanceThresholdBps / 100}%`,
        );
      }
    });

  portfolio
    .command("configure")
    .description("Configure portfolio allocations")
    .requiredOption("--allocations <json>", "Vault allocations as JSON array")
    .option(
      "--rebalance-threshold <bps>",
      "Threshold for triggering rebalance (basis points)",
      "100",
    )
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      // Parse allocations
      let allocations: Array<{
        vault: string;
        targetWeightBps: number;
        name?: string;
      }>;

      try {
        allocations = JSON.parse(opts.allocations);
      } catch {
        output.error("Invalid JSON for allocations");
        output.info("");
        output.info("Example format:");
        output.info(
          '[{"vault":"my-vault","targetWeightBps":5000,"name":"My Vault"}]',
        );
        process.exit(1);
      }

      if (!Array.isArray(allocations) || allocations.length === 0) {
        output.error("Allocations must be a non-empty array");
        process.exit(1);
      }

      // Validate each allocation
      for (const alloc of allocations) {
        if (!alloc.vault) {
          output.error("Each allocation must have a 'vault' property");
          process.exit(1);
        }
        if (
          typeof alloc.targetWeightBps !== "number" ||
          alloc.targetWeightBps < 0 ||
          alloc.targetWeightBps > 10000
        ) {
          output.error(
            `Invalid targetWeightBps for ${alloc.vault}. Must be 0-10000.`,
          );
          process.exit(1);
        }
      }

      // Validate total weight
      const totalWeight = allocations.reduce(
        (sum, a) => sum + a.targetWeightBps,
        0,
      );
      if (totalWeight !== 10000) {
        output.error(
          `Total weight must equal 10000 (100%). Got: ${totalWeight}`,
        );
        process.exit(1);
      }

      const rebalanceThresholdBps = parseInt(opts.rebalanceThreshold);

      config.portfolio = {
        allocations,
        rebalanceThresholdBps,
      };

      saveConfig(config);

      output.success("Portfolio configured");

      if (globalOpts.output !== "json") {
        output.info("");
        const rows: [string, string][] = allocations.map((a) => [
          a.name ?? a.vault,
          `${a.targetWeightBps / 100}%`,
        ]);
        output.table(["Vault", "Weight"], rows);
      }
    });

  portfolio
    .command("status")
    .description("Show current vs target allocations")
    .option("--values <json>", "Current vault values as JSON object")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const portfolioConfig = config.portfolio as
        | {
            allocations?: Array<{
              vault: string;
              targetWeightBps: number;
              name?: string;
            }>;
            rebalanceThresholdBps?: number;
          }
        | undefined;

      if (!portfolioConfig?.allocations) {
        output.error("No portfolio configured");
        process.exit(1);
      }

      // Parse current values
      let vaultValues: Record<string, BN> = {};
      if (opts.values) {
        try {
          const parsed = JSON.parse(opts.values);
          for (const [vault, value] of Object.entries(parsed)) {
            vaultValues[vault] = new BN(value as string);
          }
        } catch {
          output.error("Invalid JSON for values");
          process.exit(1);
        }
      }

      // Calculate current weights
      const totalValue = Object.values(vaultValues).reduce(
        (sum, v) => sum.add(v),
        new BN(0),
      );

      if (globalOpts.output === "json") {
        const status = portfolioConfig.allocations.map((a) => {
          const currentValue = vaultValues[a.vault] ?? new BN(0);
          const currentWeight = totalValue.isZero()
            ? 0
            : currentValue.mul(new BN(10000)).div(totalValue).toNumber();
          return {
            vault: a.vault,
            name: a.name,
            targetWeightBps: a.targetWeightBps,
            currentWeightBps: currentWeight,
            currentValue: currentValue.toString(),
            deviation: currentWeight - a.targetWeightBps,
          };
        });
        output.json({ portfolio: status, totalValue: totalValue.toString() });
        return;
      }

      output.info("Portfolio Status\n");

      const rows: [string, string, string, string][] =
        portfolioConfig.allocations.map((a) => {
          const currentValue = vaultValues[a.vault] ?? new BN(0);
          const currentWeight = totalValue.isZero()
            ? 0
            : currentValue.mul(new BN(10000)).div(totalValue).toNumber();
          const deviation = currentWeight - a.targetWeightBps;
          const deviationStr =
            deviation >= 0 ? `+${deviation / 100}%` : `${deviation / 100}%`;

          return [
            a.name ?? a.vault,
            `${a.targetWeightBps / 100}%`,
            `${currentWeight / 100}%`,
            deviationStr,
          ];
        });

      output.table(["Vault", "Target", "Current", "Deviation"], rows);

      output.info("");
      output.info(`Total value: ${totalValue.toString()}`);

      // Check if rebalance needed
      const threshold = portfolioConfig.rebalanceThresholdBps ?? 100;
      const maxDeviation = Math.max(
        ...portfolioConfig.allocations.map((a) => {
          const currentValue = vaultValues[a.vault] ?? new BN(0);
          const currentWeight = totalValue.isZero()
            ? 0
            : currentValue.mul(new BN(10000)).div(totalValue).toNumber();
          return Math.abs(currentWeight - a.targetWeightBps);
        }),
      );

      if (maxDeviation > threshold) {
        output.warn("");
        output.warn(
          `Rebalance recommended (max deviation ${maxDeviation / 100}% > threshold ${threshold / 100}%)`,
        );
      }
    });

  portfolio
    .command("deposit")
    .description("Deposit across multiple vaults according to weights")
    .requiredOption("--amount <amount>", "Total amount to deposit")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, options } = ctx;

      const portfolioConfig = config.portfolio as
        | {
            allocations?: Array<{
              vault: string;
              targetWeightBps: number;
              name?: string;
            }>;
          }
        | undefined;

      if (!portfolioConfig?.allocations) {
        output.error("No portfolio configured");
        process.exit(1);
      }

      const totalAmount = new BN(opts.amount);

      // Calculate deposit amounts per vault
      const deposits = portfolioConfig.allocations.map((a) => {
        const amount = totalAmount
          .mul(new BN(a.targetWeightBps))
          .div(new BN(10000));
        return {
          vault: a.vault,
          name: a.name ?? a.vault,
          amount,
        };
      });

      if (options.dryRun) {
        output.info("DRY RUN - Would deposit:");
        output.info(`  Total: ${totalAmount.toString()}`);
        output.info("");
        for (const d of deposits) {
          output.info(`  ${d.name}: ${d.amount.toString()}`);
        }
        return;
      }

      output.warn("Portfolio deposit requires multiple transactions");
      output.info("Deposit amounts:");
      for (const d of deposits) {
        output.info(`  ${d.name}: ${d.amount.toString()}`);
      }
      output.info("");
      output.info("Execute individual deposits:");
      for (const d of deposits) {
        output.info(
          `  solana-vault deposit ${d.vault} --amount ${d.amount.toString()}`,
        );
      }
    });

  portfolio
    .command("redeem")
    .description("Redeem from multiple vaults")
    .option("--amount <amount>", "Total amount to redeem")
    .option("--all", "Redeem all shares from all vaults")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, options } = ctx;

      const portfolioConfig = config.portfolio as
        | {
            allocations?: Array<{
              vault: string;
              name?: string;
            }>;
          }
        | undefined;

      if (!portfolioConfig?.allocations) {
        output.error("No portfolio configured");
        process.exit(1);
      }

      if (!opts.amount && !opts.all) {
        output.error("Specify --amount or --all");
        process.exit(1);
      }

      if (options.dryRun) {
        output.info("DRY RUN - Would redeem from:");
        for (const a of portfolioConfig.allocations) {
          output.info(`  ${a.name ?? a.vault}`);
        }
        return;
      }

      output.warn("Portfolio redemption requires multiple transactions");
      output.info("Redeem from each vault:");
      for (const a of portfolioConfig.allocations) {
        const amountArg = opts.all ? "--all" : `--amount <calculated>`;
        output.info(`  solana-vault redeem ${a.vault} ${amountArg}`);
      }
    });

  portfolio
    .command("rebalance")
    .description("Rebalance portfolio to match target weights")
    .option("--values <json>", "Current vault values as JSON object")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, options } = ctx;

      const portfolioConfig = config.portfolio as
        | {
            allocations?: Array<{
              vault: string;
              targetWeightBps: number;
              name?: string;
            }>;
          }
        | undefined;

      if (!portfolioConfig?.allocations) {
        output.error("No portfolio configured");
        process.exit(1);
      }

      // Parse current values
      let vaultValues: Record<string, BN> = {};
      if (opts.values) {
        try {
          const parsed = JSON.parse(opts.values);
          for (const [vault, value] of Object.entries(parsed)) {
            vaultValues[vault] = new BN(value as string);
          }
        } catch {
          output.error("Invalid JSON for values");
          process.exit(1);
        }
      }

      // Calculate total and target values
      const totalValue = Object.values(vaultValues).reduce(
        (sum, v) => sum.add(v),
        new BN(0),
      );

      if (totalValue.isZero()) {
        output.info("No value to rebalance");
        return;
      }

      const operations: Array<{
        vault: string;
        name: string;
        action: "withdraw" | "deposit";
        amount: BN;
      }> = [];

      for (const a of portfolioConfig.allocations) {
        const currentValue = vaultValues[a.vault] ?? new BN(0);
        const targetValue = totalValue
          .mul(new BN(a.targetWeightBps))
          .div(new BN(10000));
        const diff = targetValue.sub(currentValue);

        if (diff.abs().gt(new BN(0))) {
          operations.push({
            vault: a.vault,
            name: a.name ?? a.vault,
            action: diff.gt(new BN(0)) ? "deposit" : "withdraw",
            amount: diff.abs(),
          });
        }
      }

      if (operations.length === 0) {
        output.success("Portfolio is balanced");
        return;
      }

      if (options.dryRun) {
        output.info("DRY RUN - Rebalance operations:");
        for (const op of operations) {
          output.info(
            `  ${op.action.toUpperCase()} ${op.amount.toString()} to/from ${op.name}`,
          );
        }
        return;
      }

      output.info("Rebalance operations needed:");
      output.info("");

      // First, do all withdrawals
      const withdrawals = operations.filter((o) => o.action === "withdraw");
      if (withdrawals.length > 0) {
        output.info("Step 1: Withdraw from over-allocated vaults:");
        for (const w of withdrawals) {
          output.info(
            `  solana-vault withdraw ${w.vault} --amount ${w.amount.toString()}`,
          );
        }
        output.info("");
      }

      // Then, do all deposits
      const deposits = operations.filter((o) => o.action === "deposit");
      if (deposits.length > 0) {
        output.info(
          `Step ${withdrawals.length > 0 ? "2" : "1"}: Deposit to under-allocated vaults:`,
        );
        for (const d of deposits) {
          output.info(
            `  solana-vault deposit ${d.vault} --amount ${d.amount.toString()}`,
          );
        }
      }
    });

  portfolio
    .command("clear")
    .description("Clear portfolio configuration")
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config, options } = ctx;

      if (!config.portfolio) {
        output.info("No portfolio configured");
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          "Clear portfolio configuration?",
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      delete config.portfolio;
      saveConfig(config);

      output.success("Portfolio configuration cleared");
    });
}
