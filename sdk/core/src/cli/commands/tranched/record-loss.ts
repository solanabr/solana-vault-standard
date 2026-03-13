import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { TranchedVault } from "../../../tranched-vault";
import { findIdlPath, loadIdl } from "../../utils";

export function registerTranchedRecordLossCommand(parent: Command): void {
  parent
    .command("record-loss")
    .description("Record a loss (absorbed bottom-up by tranches)")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .requiredOption("-a, --amount <number>", "Total loss amount")
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

        const totalLoss = new BN(opts.amount);
        output.info(`Recording loss of ${totalLoss.toString()}`);

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Record loss? This is irreversible.");
          if (!confirmed) return;
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const sig = await vault.recordLoss(wallet.publicKey, totalLoss);

        spinner.succeed("Loss recorded");
        output.info(`Signature: ${sig}`);
      } catch (error) {
        output.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
