/** Mint Command - Mint exact shares by depositing required assets */

import { Command } from "commander";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import {
  isAllocatorVariant,
  loadVaultClient,
  resolveVaultArg,
} from "../../utils";
import { AllocatorVaultClient } from "../../../svs9";
import { SolanaVault } from "../../../vault";

export function registerMintCommand(program: Command): void {
  program
    .command("mint")
    .description("Mint exact shares from a vault")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-s, --shares <number>", "Amount of shares to mint")
    .option("--slippage <bps>", "Max slippage in basis points", "50")
    .option(
      "--max-assets <number>",
      "Maximum assets to deposit (overrides slippage)",
    )
    .option("--variant <variant>", "SVS variant (for raw vault addresses)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, provider, wallet, options } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const shares = new BN(opts.shares);
      const slippageBps = parseInt(opts.slippage);

      try {
        const vault = await loadVaultClient(provider, resolved);

        const previewAssetCost = await vault.previewMint(shares);
        const maxAssets = opts.maxAssets
          ? new BN(opts.maxAssets)
          : previewAssetCost.muln(10000 + slippageBps).divn(10000);

        output.info(`Vault: ${vaultArg}`);
        output.info(`Minting: ${shares.toString()} shares`);
        output.info(`Expected asset cost: ${previewAssetCost.toString()}`);
        output.info(
          `Maximum assets (${slippageBps}bps slippage): ${maxAssets.toString()}`,
        );

        if (options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          if (globalOpts.output === "json") {
            output.json({
              dryRun: true,
              vault: vaultArg,
              operation: "mint",
              shares: shares.toString(),
              expectedAssetCost: previewAssetCost.toString(),
              maxAssets: maxAssets.toString(),
              slippageBps,
            });
          }
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Proceed with mint?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = isAllocatorVariant(resolved.variant)
          ? await (vault as AllocatorVaultClient).mint({
              shares,
              maxAssetsIn: maxAssets,
              owner: wallet.publicKey,
              callerAssetAccount: vault.getUserAssetAccount(wallet.publicKey),
              ownerSharesAccount: vault.getUserSharesAccount(wallet.publicKey),
            })
          : await (vault as SolanaVault).mint(wallet.publicKey, {
              shares,
              maxAssetsIn: maxAssets,
            });

        spinner.succeed(`Transaction confirmed`);
        output.success(`Minted ${shares.toString()} shares`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "mint",
            shares: shares.toString(),
            expectedAssetCost: previewAssetCost.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Mint failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
