import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { CreditVault } from "../../../credit-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerRequestRedeemCommand(program: Command): void {
  program
    .command("request-redeem")
    .description("Request a redemption from an SVS-11 credit vault")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-s, --shares <number>", "Amount of shares to redeem")
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
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

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await CreditVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        output.info(`Vault: ${vaultArg}`);
        output.info(`Requesting redeem: ${shares.toString()} shares`);

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Proceed?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const sig = await vault.requestRedeem(wallet.publicKey, shares);

        spinner.succeed("Transaction confirmed");
        output.success(`Redeem requested: ${shares.toString()} shares`);
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "request-redeem",
            shares: shares.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Request redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
