/** svs9 rebalance — Adjust a child position to respect the allocator idle buffer */

import { Command } from "commander";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { formatNumber } from "../../utils";
import {
  inferChildVaultAccounts,
  loadAllocatorContext,
} from "./helpers";

export function registerSvs9RebalanceCommand(parent: Command): void {
  parent
    .command("rebalance")
    .description("Rebalance allocator idle buffer against a child vault (curator-only)")
    .requiredOption("--vault-id <number>", "Allocator vault ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint of the allocator vault")
    .requiredOption("--child-vault <pubkey>", "Child vault to rebalance")
    .requiredOption("--child-program <pubkey>", "Child vault's SVS program ID")
    .option("--child-asset-mint <pubkey>", "Child vault's asset mint")
    .option("--child-asset-vault <pubkey>", "Child vault's asset token account")
    .option("--child-shares-mint <pubkey>", "Child vault's shares mint")
    .option("--min-out <number>", "Minimum output amount for the rebalance leg", "0")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider } = ctx;

      try {
        const { client, assetMint } = await loadAllocatorContext(
          provider,
          opts.assetMint,
          opts.vaultId,
        );
        const childVault = new PublicKey(opts.childVault);
        const childProgram = new PublicKey(opts.childProgram);
        const minOut = new BN(opts.minOut);
        const inferred = await inferChildVaultAccounts(provider, childVault);

        const childAssetMint = opts.childAssetMint
          ? new PublicKey(opts.childAssetMint)
          : inferred.childAssetMint;
        const childAssetVault = opts.childAssetVault
          ? new PublicKey(opts.childAssetVault)
          : inferred.childAssetVault;
        const childSharesMint = opts.childSharesMint
          ? new PublicKey(opts.childSharesMint)
          : inferred.childSharesMint;

        output.info("═══ SVS-9 Rebalance Child Vault ═══");
        output.info(`  Allocator:       ${client.allocatorVault.toBase58()}`);
        output.info(`  Child Vault:     ${childVault.toBase58()}`);
        output.info(`  Min Out:         ${formatNumber(minOut)} assets`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with rebalance?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Rebalancing child vault...");
        spinner.start();

        const signature = await client.rebalance({
          minOut,
          childVault,
          childProgram,
          childAssetMint,
          childAssetVault,
          childSharesMint,
        });

        spinner.succeed("Rebalance complete!");
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            allocatorVault: client.allocatorVault.toBase58(),
            assetMint: assetMint.toBase58(),
            childVault: childVault.toBase58(),
            childAssetMint: childAssetMint.toBase58(),
            childAssetVault: childAssetVault.toBase58(),
            childSharesMint: childSharesMint.toBase58(),
            minOut: minOut.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Rebalance failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
