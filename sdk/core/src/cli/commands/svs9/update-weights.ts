/** svs9 update-weights — Update a child vault max allocation weight */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { loadAllocatorContext } from "./helpers";

export function registerSvs9UpdateWeightsCommand(parent: Command): void {
  parent
    .command("update-weights")
    .description("Update a child vault max weight (authority-only)")
    .requiredOption("--vault-id <number>", "Allocator vault ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint of the allocator vault")
    .requiredOption("--child-vault <pubkey>", "Child vault to update")
    .requiredOption("--max-weight <bps>", "New max weight in basis points")
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
        const childVault = new PublicKey(opts.childVault);
        const newMaxWeightBps = parseInt(opts.maxWeight, 10);

        if (newMaxWeightBps < 0 || newMaxWeightBps > 10000) {
          output.error("Max weight must be between 0 and 10000 bps.");
          process.exit(1);
        }

        output.info("═══ SVS-9 Update Child Weight ═══");
        output.info(`  Allocator:    ${client.allocatorVault.toBase58()}`);
        output.info(`  Child Vault:  ${childVault.toBase58()}`);
        output.info(`  Max Weight:   ${newMaxWeightBps} bps`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with weight update?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Updating child weight...");
        spinner.start();

        const signature = await client.updateWeights({
          childVault,
          newMaxWeightBps,
        });

        spinner.succeed("Child weight updated!");
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            allocatorVault: client.allocatorVault.toBase58(),
            childVault: childVault.toBase58(),
            newMaxWeightBps,
          });
        }
      } catch (error) {
        output.error(
          `Update weights failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
