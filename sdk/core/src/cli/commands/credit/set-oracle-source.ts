/** credit set-oracle-source — switch CreditVault between simple oracle and NavOracle adapter */

import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { CreditVault } from "../../../credit-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerSetOracleSourceCommand(program: Command): void {
  program
    .command("set-oracle-source")
    .description(
      "Switch the vault's oracle read path: 0 = simple/mock oracle, 1 = NavOracle adapter (authority only)",
    )
    .argument("<vault>", "Vault address or alias")
    .requiredOption(
      "--source <0|1>",
      "Oracle source — 0 (simple/mock) or 1 (NavOracle adapter)",
    )
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, provider, wallet, options } = ctx;

      const sourceNum = parseInt(opts.source, 10);
      if (sourceNum !== 0 && sourceNum !== 1) {
        output.error(
          `Invalid --source '${opts.source}'. Must be 0 (simple/mock) or 1 (NavOracle adapter).`,
        );
        process.exit(1);
      }

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await CreditVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        const sourceLabel = sourceNum === 0 ? "simple/mock" : "NavOracle adapter";
        output.info(`Vault:  ${vaultArg}`);
        output.info(`Source: ${sourceNum} (${sourceLabel})`);

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm(
            `Switch oracle_source to ${sourceNum} (${sourceLabel})?`,
          );
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const sig = await vault.setOracleSource(
          wallet.publicKey,
          sourceNum as 0 | 1,
        );

        spinner.succeed("oracle_source updated");
        output.success(`Source: ${sourceNum} (${sourceLabel})`);
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "set-oracle-source",
            source: sourceNum,
          });
        }
      } catch (error) {
        output.error(
          `Set oracle source failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
