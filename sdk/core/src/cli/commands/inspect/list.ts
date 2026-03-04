/** List Command - Display all configured vault aliases */

import { Command } from "commander";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { listVaultAliases } from "../../config/vault-aliases";
import { formatAddress } from "../../output";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List configured vaults")
    .option("--all", "Show all vault details")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, false, false);
      const { output, config } = ctx;

      const vaults = listVaultAliases(config);

      if (vaults.length === 0) {
        output.info(
          "No vaults configured. Add one with:\n" +
            "  solana-vault config add-vault <alias> <address> --variant svs-1",
        );
        return;
      }

      if (globalOpts.output === "json") {
        output.json(
          vaults.map(([alias, vault]) => ({
            alias,
            ...vault,
          })),
        );
        return;
      }

      if (opts.all) {
        output.table(
          ["Alias", "Address", "Variant", "Program ID", "Name"],
          vaults.map(([alias, vault]) => [
            alias,
            formatAddress(vault.address),
            vault.variant,
            vault.programId ? formatAddress(vault.programId) : "-",
            vault.name || "-",
          ]),
        );
      } else {
        output.table(
          ["Alias", "Address", "Variant"],
          vaults.map(([alias, vault]) => [
            alias,
            formatAddress(vault.address),
            vault.variant,
          ]),
        );
      }

      output.info(`${vaults.length} vault(s) configured`);
    });
}
