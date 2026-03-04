/** Config Commands - Initialize, manage vaults, profiles, and settings */

import { Command } from "commander";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import {
  loadConfig,
  saveConfig,
  initConfig,
  configExists,
  getConfigPath,
} from "../../config";
import {
  addVaultAlias,
  removeVaultAlias,
  listVaultAliases,
} from "../../config/vault-aliases";
import { SvsVariant, VaultAlias } from "../../types";
import { formatAddress } from "../../output";

export function registerConfigCommands(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Manage CLI configuration");

  configCmd
    .command("init")
    .description("Initialize CLI configuration")
    .option("-f, --force", "Overwrite existing config")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, false, false);
      const { output } = ctx;

      if (configExists() && !opts.force) {
        output.warn(
          `Config already exists at ${getConfigPath()}\n` +
            "Use --force to overwrite",
        );
        return;
      }

      initConfig();
      output.success(`Config initialized at ${getConfigPath()}`);
    });

  configCmd
    .command("show")
    .description("Show current configuration")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, false, false);
      const { output, config } = ctx;

      if (globalOpts.output === "json") {
        output.json(config);
        return;
      }

      output.info("Current Configuration:");
      output.table(
        ["Setting", "Value"],
        [
          ["Cluster", config.defaults.cluster],
          ["Keypair", config.defaults.keypair],
          ["Output", config.defaults.output],
          ["Confirmation", config.defaults.confirmation],
        ],
      );

      const profiles = Object.keys(config.profiles);
      if (profiles.length > 0) {
        output.info(`\nProfiles: ${profiles.join(", ")}`);
      }

      const vaults = listVaultAliases(config);
      if (vaults.length > 0) {
        output.info("\nVaults:");
        output.table(
          ["Alias", "Address", "Variant"],
          vaults.map(([alias, vault]) => [
            alias,
            formatAddress(vault.address),
            vault.variant,
          ]),
        );
      }
    });

  configCmd
    .command("add-vault")
    .description("Add a vault alias")
    .argument("<alias>", "Alias name for the vault")
    .argument("<address>", "Vault address")
    .requiredOption(
      "--variant <variant>",
      "SVS variant: svs-1, svs-2, svs-3, svs-4",
    )
    .option("--program-id <pubkey>", "Custom program ID")
    .option("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID")
    .option("--name <name>", "Human-readable name")
    .action(async (alias, address, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, false, false);
      const { output } = ctx;

      const validVariants: SvsVariant[] = ["svs-1", "svs-2", "svs-3", "svs-4"];
      if (!validVariants.includes(opts.variant as SvsVariant)) {
        output.error(
          `Invalid variant: ${opts.variant}. Use: ${validVariants.join(", ")}`,
        );
        process.exit(1);
      }

      const vault: VaultAlias = {
        address,
        variant: opts.variant as SvsVariant,
        ...(opts.programId && { programId: opts.programId }),
        ...(opts.assetMint && { assetMint: opts.assetMint }),
        ...(opts.vaultId && { vaultId: parseInt(opts.vaultId) }),
        ...(opts.name && { name: opts.name }),
      };

      try {
        let config = loadConfig();
        config = addVaultAlias(config, alias, vault);
        saveConfig(config);
        output.success(`Vault "${alias}" added`);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  configCmd
    .command("remove-vault")
    .description("Remove a vault alias")
    .argument("<alias>", "Alias to remove")
    .action(async (alias, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, false, false);
      const { output } = ctx;

      try {
        let config = loadConfig();
        config = removeVaultAlias(config, alias);
        saveConfig(config);
        output.success(`Vault "${alias}" removed`);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  configCmd
    .command("set")
    .description("Set a configuration value")
    .argument("<key>", "Config key (cluster, keypair, output, confirmation)")
    .argument("<value>", "Value to set")
    .action(async (key, value, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, false, false);
      const { output } = ctx;

      const validKeys = ["cluster", "keypair", "output", "confirmation"];
      if (!validKeys.includes(key)) {
        output.error(
          `Invalid key: ${key}. Valid keys: ${validKeys.join(", ")}`,
        );
        process.exit(1);
      }

      if (key === "cluster") {
        const validClusters = ["devnet", "mainnet-beta", "testnet", "localnet"];
        if (!validClusters.includes(value)) {
          output.error(
            `Invalid cluster: ${value}. Use: ${validClusters.join(", ")}`,
          );
          process.exit(1);
        }
      }

      if (key === "output") {
        const validOutputs = ["table", "json", "csv"];
        if (!validOutputs.includes(value)) {
          output.error(
            `Invalid output: ${value}. Use: ${validOutputs.join(", ")}`,
          );
          process.exit(1);
        }
      }

      if (key === "confirmation") {
        const validConfirmations = ["processed", "confirmed", "finalized"];
        if (!validConfirmations.includes(value)) {
          output.error(
            `Invalid confirmation: ${value}. Use: ${validConfirmations.join(", ")}`,
          );
          process.exit(1);
        }
      }

      let config = loadConfig();
      (config.defaults as Record<string, string>)[key] = value;
      saveConfig(config);
      output.success(`Set ${key} = ${value}`);
    });
}
