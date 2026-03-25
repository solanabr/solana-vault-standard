/** svs9 deallocate — Redeem child shares back into allocator idle liquidity */

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

export function registerSvs9DeallocateCommand(parent: Command): void {
  parent
    .command("deallocate")
    .description("Redeem child vault shares back to idle liquidity (curator-only)")
    .requiredOption("--vault-id <number>", "Allocator vault ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint of the allocator vault")
    .requiredOption("--child-vault <pubkey>", "Child vault to deallocate from")
    .requiredOption("--child-program <pubkey>", "Child vault's SVS program ID")
    .requiredOption("--shares <number>", "Child shares to redeem")
    .option("--child-asset-mint <pubkey>", "Child vault's asset mint")
    .option("--child-asset-vault <pubkey>", "Child vault's asset token account")
    .option("--child-shares-mint <pubkey>", "Child vault's shares mint")
    .option("--min-assets-out <number>", "Minimum assets to receive", "0")
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
        const sharesToWithdraw = new BN(opts.shares);
        const minAssetsOut = new BN(opts.minAssetsOut);
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

        output.info("═══ SVS-9 Deallocate from Child Vault ═══");
        output.info(`  Allocator:       ${client.allocatorVault.toBase58()}`);
        output.info(`  Child Vault:     ${childVault.toBase58()}`);
        output.info(`  Shares In:       ${formatNumber(sharesToWithdraw)} shares`);
        output.info(`  Min Assets Out:  ${formatNumber(minAssetsOut)} assets`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with deallocation?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Deallocating from child vault...");
        spinner.start();

        const signature = await client.deallocate({
          sharesToWithdraw,
          minAssetsOut,
          childVault,
          childProgram,
          childAssetMint,
          childAssetVault,
          childSharesMint,
        });

        spinner.succeed("Deallocation complete!");
        output.success(`Redeemed ${formatNumber(sharesToWithdraw)} child shares`);
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
            sharesToWithdraw: sharesToWithdraw.toString(),
            minAssetsOut: minAssetsOut.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Deallocation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
