/** svs9 allocate — Curator sends idle funds to a child vault */

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

export function registerSvs9AllocateCommand(parent: Command): void {
  parent
    .command("allocate")
    .description("Allocate idle funds to a child vault (curator-only)")
    .requiredOption("--vault-id <number>", "Allocator vault ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint of the allocator vault")
    .requiredOption("--child-vault <pubkey>", "Child vault to allocate into")
    .requiredOption("--child-program <pubkey>", "Child vault's SVS program ID")
    .option("--child-asset-mint <pubkey>", "Child vault's asset mint")
    .option("--child-asset-vault <pubkey>", "Child vault's asset token account")
    .option("--child-shares-mint <pubkey>", "Child vault's shares mint")
    .requiredOption("-a, --amount <number>", "Amount of assets to allocate")
    .option(
      "--min-shares-out <number>",
      "Minimum child shares expected from the allocation CPI",
      "0",
    )
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
        const amount = new BN(opts.amount);
        const minSharesOut = new BN(opts.minSharesOut);
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

        output.info("═══ SVS-9 Allocate to Child Vault ═══");
        output.info(`  Allocator:       ${client.allocatorVault.toBase58()}`);
        output.info(`  Child Vault:     ${childVault.toBase58()}`);
        output.info(`  Amount:          ${formatNumber(amount)} lamports`);
        output.info(`  Min Shares Out:  ${formatNumber(minSharesOut)} shares`);
        output.info(`  Child Program:   ${childProgram.toBase58()}`);
        output.info(`  Child Asset:     ${childAssetMint.toBase58()}`);
        output.info(`  Child Shares:    ${childSharesMint.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with allocation?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Allocating to child vault...");
        spinner.start();

        const signature = await client.allocate({
          assets: amount,
          minSharesOut,
          childVault,
          childProgram,
          childAssetMint,
          childAssetVault,
          childSharesMint,
        });

        spinner.succeed("Allocation complete!");
        output.success(`Allocated ${formatNumber(amount)} assets to child vault`);
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
            amount: amount.toString(),
            minSharesOut: minSharesOut.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Allocation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
