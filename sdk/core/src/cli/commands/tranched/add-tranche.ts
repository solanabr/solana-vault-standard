import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { TranchedVault } from "../../../tranched-vault";
import { findIdlPath, loadIdl } from "../../utils";

export function registerTranchedAddTrancheCommand(parent: Command): void {
  parent
    .command("add-tranche")
    .description("Add a tranche to a tranched vault")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .requiredOption("--priority <number>", "Tranche priority (0=senior)")
    .requiredOption("--sub-bps <number>", "Subordination basis points")
    .option("--yield-bps <number>", "Target yield basis points", "0")
    .option("--cap-bps <number>", "Cap basis points", "10000")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet, options } = ctx;

      const idlPath = findIdlPath("svs-1");
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const assetMint = new PublicKey(opts.assetMint);
        const vault = await TranchedVault.load(prog, assetMint, new BN(opts.vaultId));

        const priority = parseInt(opts.priority);
        const subordinationBps = parseInt(opts.subBps);
        const targetYieldBps = parseInt(opts.yieldBps);
        const capBps = parseInt(opts.capBps);

        output.info(`Priority: ${priority}, Sub: ${subordinationBps}bps, Yield: ${targetYieldBps}bps, Cap: ${capBps}bps`);

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Add tranche?");
          if (!confirmed) return;
        }

        const spinner = output.spinner("Adding tranche...");
        spinner.start();

        const sig = await vault.addTranche(wallet.publicKey, {
          priority,
          subordinationBps,
          targetYieldBps,
          capBps,
        });

        spinner.succeed("Tranche added");
        output.info(`Signature: ${sig}`);
      } catch (error) {
        output.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
