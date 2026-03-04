/** Redeem Command - Redeem shares for underlying assets */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolanaVault } from "../../../vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerRedeemCommand(program: Command): void {
  program
    .command("redeem")
    .description("Redeem shares for assets from a vault")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-s, --shares <number>", "Amount of shares to redeem")
    .option("--slippage <bps>", "Max slippage in basis points", "50")
    .option(
      "--min-assets <number>",
      "Minimum assets to receive (overrides slippage)",
    )
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, provider, wallet, options } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      const shares = new BN(opts.shares);
      const slippageBps = parseInt(opts.slippage);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await SolanaVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        const previewAssets = await vault.previewRedeem(shares);
        const minAssets = opts.minAssets
          ? new BN(opts.minAssets)
          : previewAssets.muln(10000 - slippageBps).divn(10000);

        output.info(`Vault: ${vaultArg}`);
        output.info(`Redeeming: ${shares.toString()} shares`);
        output.info(`Expected assets: ${previewAssets.toString()}`);
        output.info(
          `Minimum assets (${slippageBps}bps slippage): ${minAssets.toString()}`,
        );

        if (options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          if (globalOpts.output === "json") {
            output.json({
              dryRun: true,
              vault: vaultArg,
              operation: "redeem",
              shares: shares.toString(),
              expectedAssets: previewAssets.toString(),
              minAssets: minAssets.toString(),
              slippageBps,
            });
          }
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Proceed with redeem?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.redeem(wallet.publicKey, {
          shares,
          minAssetsOut: minAssets,
        });

        spinner.succeed(`Transaction confirmed`);
        output.success(`Redeemed ${shares.toString()} shares`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "redeem",
            shares: shares.toString(),
            expectedAssets: previewAssets.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
