import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { TranchedVault } from "../../../tranched-vault";
import { findIdlPath, loadIdl } from "../../utils";

export function registerTranchedInitializeCommand(parent: Command): void {
  parent
    .command("initialize")
    .description("Initialize a new tranched vault")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .option(
      "--waterfall <mode>",
      "Waterfall mode: sequential (0) or prorata (1)",
      "0",
    )
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, options } = ctx;

      const idlPath = findIdlPath("svs-12");
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const assetMint = new PublicKey(opts.assetMint);
        const vaultId = new BN(opts.vaultId);
        const waterfallMode = parseInt(opts.waterfall);

        output.info(`Asset mint: ${assetMint.toBase58()}`);
        output.info(`Vault ID: ${vaultId.toString()}`);
        output.info(
          `Waterfall: ${waterfallMode === 0 ? "Sequential" : "ProRata"}`,
        );

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Create tranched vault?");
          if (!confirmed) return;
        }

        const spinner = output.spinner("Creating vault...");
        spinner.start();

        const vault = await TranchedVault.create(prog, {
          assetMint,
          vaultId,
          waterfallMode,
        });

        spinner.succeed("Vault created");
        output.success(`Vault address: ${vault.vault.toBase58()}`);
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
