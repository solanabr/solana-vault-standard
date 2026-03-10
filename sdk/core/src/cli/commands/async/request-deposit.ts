import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { AsyncVault } from "../../../async-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerRequestDepositCommand(program: Command): void {
  program
    .command("request-deposit")
    .description("Request an async deposit into an SVS-10 vault")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-a, --amount <number>", "Amount of assets to deposit")
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
    .option("--receiver <pubkey>", "Receiver of shares (defaults to signer)")
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

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await AsyncVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        output.info(`Vault: ${vaultArg}`);
        output.info(`Requesting deposit: ${amount.toString()} assets`);

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

        const receiver = opts.receiver
          ? new PublicKey(opts.receiver)
          : undefined;
        const sig = await vault.requestDeposit(wallet.publicKey, {
          assets: amount,
          receiver,
        });

        spinner.succeed("Transaction confirmed");
        output.success(`Deposit requested: ${amount.toString()} assets`);
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "request-deposit",
            assets: amount.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Request deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
