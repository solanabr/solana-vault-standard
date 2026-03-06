/** Strategy Commands - Manage vault strategy deployment and allocation */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVaultArg, saveConfig, isValidPublicKey } from "../../utils";
import {
  StrategyType,
  StrategyStatus,
  createLendingStrategy,
  createLiquidStakingStrategy,
  createLpStrategy,
} from "../../../strategy";

// Stored strategy format (serializable)
interface StoredStrategy {
  id: string;
  name: string;
  type: StrategyType;
  status: StrategyStatus;
  programId?: string;
  poolAccount?: string;
  receiptMint?: string;
}

interface StoredPosition {
  strategyId: string;
  currentValue: string;
  receiptTokenBalance: string;
  lastUpdate: number;
}

export function registerStrategyCommands(program: Command): void {
  const strategy = program
    .command("strategy")
    .description("Manage vault strategy deployment and allocation");

  strategy
    .command("show")
    .description("Show configured strategies and current positions")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const strategyData = config.strategies?.[vaultArg] as
        | {
            strategies?: Record<string, StoredStrategy>;
            positions?: Record<string, StoredPosition>;
            targetWeights?: Record<string, number>;
          }
        | undefined;

      if (
        !strategyData?.strategies ||
        Object.keys(strategyData.strategies).length === 0
      ) {
        output.info(`No strategies configured for ${vaultArg}`);
        output.info("");
        output.info("Add a strategy with:");
        output.info(
          `  solana-vault strategy add ${vaultArg} --type lending --name "Kamino USDC"`,
        );
        return;
      }

      const strategies = Object.values(strategyData.strategies);
      const positions = strategyData.positions ?? {};
      const weights = strategyData.targetWeights ?? {};

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          strategies,
          positions,
          targetWeights: weights,
        });
        return;
      }

      output.info(`Strategies for ${vaultArg}\n`);

      const rows: [string, string, string, string, string][] = strategies.map(
        (s) => {
          const position = positions[s.id];
          const weight = weights[s.id] ?? 0;
          const deployed = position?.currentValue ?? "0";
          return [s.name, s.type, s.status, `${weight / 100}%`, deployed];
        },
      );

      output.table(["Name", "Type", "Status", "Target", "Deployed"], rows);

      // Show if rebalance needed
      if (
        Object.keys(positions).length > 0 &&
        Object.keys(weights).length > 0
      ) {
        const totalValue = Object.values(positions).reduce(
          (sum, p) => sum + BigInt(p.currentValue),
          BigInt(0),
        );

        if (totalValue > BigInt(0)) {
          let maxDeviation = 0;
          for (const [id, targetWeight] of Object.entries(weights)) {
            const currentValue = BigInt(positions[id]?.currentValue ?? "0");
            const currentWeight = Number(
              (currentValue * BigInt(10000)) / totalValue,
            );
            const deviation = Math.abs(currentWeight - targetWeight);
            if (deviation > maxDeviation) {
              maxDeviation = deviation;
            }
          }

          if (maxDeviation > 100) {
            // 1% threshold
            output.info("");
            output.warn(
              "Portfolio needs rebalancing. Run: solana-vault strategy rebalance",
            );
          }
        }
      }
    });

  strategy
    .command("add")
    .description("Add a new strategy")
    .argument("<vault>", "Vault address or alias")
    .requiredOption(
      "--type <type>",
      "Strategy type: lending, liquid-staking, lp, custom",
    )
    .requiredOption("--name <name>", "Strategy name")
    .option("--program-id <pubkey>", "Target protocol program ID")
    .option("--pool <pubkey>", "Pool or stake account address")
    .option(
      "--receipt-mint <pubkey>",
      "Receipt token mint (cToken, stToken, LP)",
    )
    .option("--weight <bps>", "Target allocation weight in basis points", "0")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      // Validate type
      const validTypes = ["lending", "liquid-staking", "lp", "custom"];
      const type = opts.type.toLowerCase();
      if (!validTypes.includes(type)) {
        output.error(`Type must be: ${validTypes.join(", ")}`);
        process.exit(1);
      }

      // Generate strategy ID
      const strategyId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Parse optional pubkeys
      let programId: string | undefined;
      let poolAccount: string | undefined;
      let receiptMint: string | undefined;

      if (opts.programId) {
        if (!isValidPublicKey(opts.programId)) {
          output.error("Invalid program ID");
          process.exit(1);
        }
        programId = opts.programId;
      }

      if (opts.pool) {
        if (!isValidPublicKey(opts.pool)) {
          output.error("Invalid pool address");
          process.exit(1);
        }
        poolAccount = opts.pool;
      }

      if (opts.receiptMint) {
        if (!isValidPublicKey(opts.receiptMint)) {
          output.error("Invalid receipt mint");
          process.exit(1);
        }
        receiptMint = opts.receiptMint;
      }

      const weight = parseInt(opts.weight);

      // Map type string to StrategyType enum
      const strategyType =
        type === "lending"
          ? StrategyType.Lending
          : type === "liquid-staking"
            ? StrategyType.LiquidStaking
            : type === "lp"
              ? StrategyType.LiquidityProvision
              : StrategyType.Custom;

      // Save to config
      if (!config.strategies) {
        config.strategies = {};
      }
      if (!config.strategies[vaultArg]) {
        config.strategies[vaultArg] = {
          strategies: {},
          positions: {},
          targetWeights: {},
        };
      }

      const vaultStrategies = config.strategies[vaultArg] as {
        strategies: Record<string, StoredStrategy>;
        positions: Record<string, StoredPosition>;
        targetWeights: Record<string, number>;
      };

      vaultStrategies.strategies[strategyId] = {
        id: strategyId,
        name: opts.name,
        type: strategyType,
        status: StrategyStatus.Active,
        programId,
        poolAccount,
        receiptMint,
      };

      if (weight > 0) {
        vaultStrategies.targetWeights[strategyId] = weight;
      }

      config.strategies[vaultArg] = vaultStrategies;
      saveConfig(config);

      output.success(`Strategy added: ${opts.name}`);
      output.info(`ID: ${strategyId}`);

      if (weight > 0) {
        output.info(`Target weight: ${weight / 100}%`);
      }
    });

  strategy
    .command("remove")
    .description("Remove a strategy")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--strategy-id <id>", "Strategy ID to remove")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, options } = ctx;

      const vaultStrategies = config.strategies?.[vaultArg] as
        | {
            strategies: Record<string, StoredStrategy>;
            positions: Record<string, StoredPosition>;
            targetWeights: Record<string, number>;
          }
        | undefined;

      if (!vaultStrategies?.strategies?.[opts.strategyId]) {
        output.error(`Strategy ${opts.strategyId} not found`);
        process.exit(1);
      }

      const position = vaultStrategies.positions?.[opts.strategyId];
      if (position && BigInt(position.currentValue) > BigInt(0)) {
        output.warn(
          "Strategy has deployed assets. Recall assets before removing.",
        );
        if (!options.yes) {
          const confirmed = await output.confirm("Remove anyway?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }
      }

      const strategyName = vaultStrategies.strategies[opts.strategyId].name;

      delete vaultStrategies.strategies[opts.strategyId];
      delete vaultStrategies.positions?.[opts.strategyId];
      delete vaultStrategies.targetWeights?.[opts.strategyId];

      config.strategies![vaultArg] = vaultStrategies;
      saveConfig(config);

      output.success(`Strategy removed: ${strategyName}`);
    });

  strategy
    .command("set-weight")
    .description("Set target allocation weight for a strategy")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--strategy-id <id>", "Strategy ID")
    .requiredOption("--weight <bps>", "Target weight in basis points (0-10000)")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const vaultStrategies = config.strategies?.[vaultArg] as
        | {
            strategies: Record<string, StoredStrategy>;
            targetWeights: Record<string, number>;
          }
        | undefined;

      if (!vaultStrategies?.strategies?.[opts.strategyId]) {
        output.error(`Strategy ${opts.strategyId} not found`);
        process.exit(1);
      }

      const weight = parseInt(opts.weight);
      if (isNaN(weight) || weight < 0 || weight > 10000) {
        output.error("Weight must be between 0 and 10000 basis points");
        process.exit(1);
      }

      if (!vaultStrategies.targetWeights) {
        vaultStrategies.targetWeights = {};
      }
      vaultStrategies.targetWeights[opts.strategyId] = weight;

      // Validate total doesn't exceed 100%
      const totalWeight = Object.values(vaultStrategies.targetWeights).reduce(
        (a, b) => a + b,
        0,
      );
      if (totalWeight > 10000) {
        output.error(
          `Total weights would be ${totalWeight / 100}%. Must not exceed 100%.`,
        );
        process.exit(1);
      }

      config.strategies![vaultArg] = vaultStrategies;
      saveConfig(config);

      const strategyName = vaultStrategies.strategies[opts.strategyId].name;
      output.success(`Weight set for ${strategyName}: ${weight / 100}%`);
      output.info(`Total allocation: ${totalWeight / 100}%`);
    });

  strategy
    .command("deploy")
    .description("Deploy assets to strategies")
    .argument("<vault>", "Vault address or alias")
    .option(
      "--amount <amount>",
      "Amount to deploy (default: use target weights)",
    )
    .option("--strategy-id <id>", "Deploy to specific strategy")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, options } = ctx;

      const vaultStrategies = config.strategies?.[vaultArg] as
        | {
            strategies: Record<string, StoredStrategy>;
            targetWeights: Record<string, number>;
          }
        | undefined;

      if (
        !vaultStrategies?.strategies ||
        Object.keys(vaultStrategies.strategies).length === 0
      ) {
        output.error("No strategies configured");
        process.exit(1);
      }

      if (options.dryRun) {
        output.info("DRY RUN - Would deploy assets:");
        if (opts.strategyId) {
          output.info(`  Strategy: ${opts.strategyId}`);
          output.info(`  Amount: ${opts.amount ?? "all available"}`);
        } else {
          output.info("  Distributing according to target weights:");
          for (const [id, weight] of Object.entries(
            vaultStrategies.targetWeights ?? {},
          )) {
            const name = vaultStrategies.strategies[id]?.name ?? id;
            output.info(`    ${name}: ${weight / 100}%`);
          }
        }
        return;
      }

      output.warn("Strategy deployment requires SDK integration");
      output.info("Use the SDK directly to deploy assets to protocols");
    });

  strategy
    .command("recall")
    .description("Recall assets from strategies")
    .argument("<vault>", "Vault address or alias")
    .option("--amount <amount>", "Amount to recall")
    .option("--strategy-id <id>", "Recall from specific strategy")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, options } = ctx;

      if (options.dryRun) {
        output.info("DRY RUN - Would recall assets:");
        if (opts.strategyId) {
          output.info(`  Strategy: ${opts.strategyId}`);
        }
        output.info(`  Amount: ${opts.amount ?? "all"}`);
        return;
      }

      output.warn("Strategy recall requires SDK integration");
      output.info("Use the SDK directly to recall assets from protocols");
    });

  strategy
    .command("rebalance")
    .description("Rebalance strategies to match target weights")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, options } = ctx;

      const vaultStrategies = config.strategies?.[vaultArg] as
        | {
            strategies: Record<string, StoredStrategy>;
            positions: Record<string, StoredPosition>;
            targetWeights: Record<string, number>;
          }
        | undefined;

      if (!vaultStrategies?.targetWeights) {
        output.error("No target weights configured");
        process.exit(1);
      }

      if (options.dryRun) {
        output.info("DRY RUN - Would rebalance to target weights:");
        for (const [id, weight] of Object.entries(
          vaultStrategies.targetWeights,
        )) {
          const name = vaultStrategies.strategies?.[id]?.name ?? id;
          const current = vaultStrategies.positions?.[id]?.currentValue ?? "0";
          output.info(`  ${name}: ${current} -> target ${weight / 100}%`);
        }
        return;
      }

      output.warn("Strategy rebalancing requires SDK integration");
      output.info("Use the SDK directly to rebalance portfolio");
    });

  strategy
    .command("health")
    .description("Check strategy health status")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const vaultStrategies = config.strategies?.[vaultArg] as
        | {
            strategies: Record<string, StoredStrategy>;
            positions: Record<string, StoredPosition>;
          }
        | undefined;

      if (!vaultStrategies?.strategies) {
        output.info(`No strategies configured for ${vaultArg}`);
        return;
      }

      const strategies = Object.values(vaultStrategies.strategies);

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          strategies: strategies.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            healthy: s.status === StrategyStatus.Active,
          })),
        });
        return;
      }

      output.info(`Strategy Health for ${vaultArg}\n`);

      const rows: [string, string, string][] = strategies.map((s) => {
        const statusIcon =
          s.status === StrategyStatus.Active
            ? "OK"
            : s.status === StrategyStatus.Paused
              ? "PAUSED"
              : "WARN";
        return [s.name, s.status.toUpperCase(), statusIcon];
      });

      output.table(["Strategy", "Status", "Health"], rows);

      const activeCount = strategies.filter(
        (s) => s.status === StrategyStatus.Active,
      ).length;
      output.info("");
      output.info(`${activeCount}/${strategies.length} strategies active`);
    });

  strategy
    .command("clear")
    .description("Clear all strategy configuration")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config, options } = ctx;

      if (!config.strategies?.[vaultArg]) {
        output.info(`No strategy configuration for ${vaultArg}`);
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          `Clear all strategy configuration for ${vaultArg}?`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      delete config.strategies[vaultArg];
      saveConfig(config);

      output.success(`Strategy configuration cleared for ${vaultArg}`);
    });
}
