import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { TranchedVault } from "../../../tranched-vault";
import { findIdlPath, loadIdl } from "../../utils";

export function registerTranchedDistributeYieldCommand(parent: Command): void {
  parent
    .command("distribute-yield")
    .description("Distribute yield across tranches via waterfall")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .requiredOption("-a, --amount <number>", "Total yield amount")
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
        const vault = await TranchedVault.load(
          prog,
          assetMint,
          new BN(opts.vaultId),
        );

        const totalYield = new BN(opts.amount);
        output.info(`Distributing ${totalYield.toString()} yield`);

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Distribute yield?");
          if (!confirmed) return;
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const sig = await vault.distributeYield(wallet.publicKey, totalYield);

        spinner.succeed("Yield distributed");
        output.info(`Signature: ${sig}`);
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
