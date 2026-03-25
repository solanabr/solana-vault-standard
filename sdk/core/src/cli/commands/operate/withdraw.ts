/** Withdraw Command - Withdraw exact assets from a vault by burning shares */

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

export function registerWithdrawCommand(program: Command): void {
  program
    .command("withdraw")
    .description("Withdraw assets from a vault")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-a, --amount <number>", "Amount of assets to withdraw")
    .option("-s, --slippage <bps>", "Max slippage in basis points", "50")
    .option(
      "--max-shares <number>",
      "Maximum shares to burn (overrides slippage)",
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

      const amount = new BN(opts.amount);
      const slippageBps = parseInt(opts.slippage);

      try {
        const vault = await loadVaultClient(provider, resolved);

        const previewSharesBurned = await vault.previewWithdraw(amount);
        const maxShares = opts.maxShares
          ? new BN(opts.maxShares)
          : previewSharesBurned.muln(10000 + slippageBps).divn(10000);

        output.info(`Vault: ${vaultArg}`);
        output.info(`Withdrawing: ${amount.toString()} assets`);
        output.info(
          `Expected shares burned: ${previewSharesBurned.toString()}`,
        );
        output.info(
          `Maximum shares (${slippageBps}bps slippage): ${maxShares.toString()}`,
        );

        if (options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          if (globalOpts.output === "json") {
            output.json({
              dryRun: true,
              vault: vaultArg,
              operation: "withdraw",
              assets: amount.toString(),
              expectedSharesBurned: previewSharesBurned.toString(),
              maxShares: maxShares.toString(),
              slippageBps,
            });
          }
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Proceed with withdrawal?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = isAllocatorVariant(resolved.variant)
          ? await (vault as AllocatorVaultClient).withdraw({
              assets: amount,
              maxSharesIn: maxShares,
              owner: wallet.publicKey,
              callerAssetAccount: vault.getUserAssetAccount(wallet.publicKey),
              ownerSharesAccount: vault.getUserSharesAccount(wallet.publicKey),
            })
          : await (vault as SolanaVault).withdraw(wallet.publicKey, {
              assets: amount,
              maxSharesIn: maxShares,
            });

        spinner.succeed(`Transaction confirmed`);
        output.success(`Withdrew ${amount.toString()} assets`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "withdraw",
            assets: amount.toString(),
            expectedSharesBurned: previewSharesBurned.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Withdraw failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
