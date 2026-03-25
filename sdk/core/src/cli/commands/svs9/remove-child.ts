/** svs9 remove-child — Disable a child vault in the allocator */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { loadAllocatorContext } from "./helpers";

export function registerSvs9RemoveChildCommand(parent: Command): void {
  parent
    .command("remove-child")
    .description("Disable a child vault in the allocator (authority-only)")
    .requiredOption("--vault-id <number>", "Allocator vault ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint of the allocator vault")
    .requiredOption("--child-vault <pubkey>", "Child vault to disable")
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

        output.info("═══ SVS-9 Remove Child Vault ═══");
        output.info(`  Allocator:    ${client.allocatorVault.toBase58()}`);
        output.info(`  Child Vault:  ${childVault.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with child removal?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Removing child vault...");
        spinner.start();

        const signature = await client.removeChild({ childVault });

        spinner.succeed("Child vault removed!");
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            allocatorVault: client.allocatorVault.toBase58(),
            childVault: childVault.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Remove child failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
