/** Deposit Command - Deposit assets into a vault and receive shares */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolanaVault } from "../../../vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerDepositCommand(program: Command): void {
  program
    .command("deposit")
    .description("Deposit assets into a vault")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-a, --amount <number>", "Amount of assets to deposit")
    .option("-s, --slippage <bps>", "Max slippage in basis points", "50")
    .option(
      "--min-shares <number>",
      "Minimum shares to receive (overrides slippage)",
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

        const previewShares = await vault.previewDeposit(amount);
        const minShares = opts.minShares
          ? new BN(opts.minShares)
          : previewShares.muln(10000 - slippageBps).divn(10000);

        output.info(`Vault: ${vaultArg}`);
        output.info(`Depositing: ${amount.toString()} assets`);
        output.info(`Expected shares: ${previewShares.toString()}`);
        output.info(
          `Minimum shares (${slippageBps}bps slippage): ${minShares.toString()}`,
        );

        if (options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          if (globalOpts.output === "json") {
            output.json({
              dryRun: true,
              vault: vaultArg,
              operation: "deposit",
              assets: amount.toString(),
              expectedShares: previewShares.toString(),
              minShares: minShares.toString(),
              slippageBps,
            });
          }
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Proceed with deposit?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.deposit(wallet.publicKey, {
          assets: amount,
          minSharesOut: minShares,
        });

        spinner.succeed(`Transaction confirmed`);
        output.success(`Deposited ${amount.toString()} assets`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "deposit",
            assets: amount.toString(),
            expectedShares: previewShares.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
