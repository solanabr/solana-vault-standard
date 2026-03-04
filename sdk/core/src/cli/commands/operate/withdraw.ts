/** Withdraw Command - Withdraw exact assets from a vault by burning shares */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolanaVault } from "../../../vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

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

      const amount = new BN(opts.amount);
      const slippageBps = parseInt(opts.slippage);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await SolanaVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

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

        const signature = await vault.withdraw(wallet.publicKey, {
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
