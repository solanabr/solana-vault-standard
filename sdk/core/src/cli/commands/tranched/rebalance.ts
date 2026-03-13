import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { TranchedVault } from "../../../tranched-vault";
import { findIdlPath, loadIdl } from "../../utils";

export function registerTranchedRebalanceCommand(parent: Command): void {
  parent
    .command("rebalance")
    .description("Rebalance allocation between two tranches")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .requiredOption("--from <number>", "Source tranche index")
    .requiredOption("--to <number>", "Destination tranche index")
    .requiredOption("-a, --amount <number>", "Amount to move")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet, options } = ctx;

      const idlPath = findIdlPath("svs-12");
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const assetMint = new PublicKey(opts.assetMint);
        const vault = await TranchedVault.load(prog, assetMint, new BN(opts.vaultId));

        const fromIndex = parseInt(opts.from);
        const toIndex = parseInt(opts.to);
        const amount = new BN(opts.amount);

        output.info(`Rebalancing ${amount.toString()} from tranche ${fromIndex} to ${toIndex}`);

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Rebalance tranches?");
          if (!confirmed) return;
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const sig = await vault.rebalance(wallet.publicKey, fromIndex, toIndex, amount);

        spinner.succeed("Rebalance complete");
        output.info(`Signature: ${sig}`);
      } catch (error) {
        output.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
