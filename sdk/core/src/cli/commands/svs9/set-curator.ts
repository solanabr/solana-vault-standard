/** svs9 set-curator — Update the allocator vault curator */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { loadAllocatorContext } from "./helpers";

export function registerSvs9SetCuratorCommand(parent: Command): void {
  parent
    .command("set-curator")
    .description("Set a new allocator vault curator (authority-only)")
    .requiredOption("--vault-id <number>", "Allocator vault ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint of the allocator vault")
    .requiredOption("--new-curator <pubkey>", "New curator public key")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider } = ctx;

      try {
        const { client } = await loadAllocatorContext(
          provider,
          opts.assetMint,
          opts.vaultId,
        );
        const newCurator = new PublicKey(opts.newCurator);

        output.info("═══ SVS-9 Set Curator ═══");
        output.info(`  Allocator:    ${client.allocatorVault.toBase58()}`);
        output.info(`  New Curator:  ${newCurator.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with curator update?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Updating curator...");
        spinner.start();

        const signature = await client.setCurator(newCurator);

        spinner.succeed("Curator updated!");
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            allocatorVault: client.allocatorVault.toBase58(),
            newCurator: newCurator.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Set curator failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
