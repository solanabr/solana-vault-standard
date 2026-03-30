import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { CreditVault } from "../../../credit-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerRepayCommand(program: Command): void {
  program
    .command("repay")
    .description("Repay assets to the credit vault (manager only)")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-a, --amount <number>", "Amount of assets to repay")
    .option(
      "--manager-token-account <pubkey>",
      "Manager token account (defaults to ATA)",
    )
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

      const amount = new BN(opts.amount);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await CreditVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        const managerTokenAccount = opts.managerTokenAccount
          ? new PublicKey(opts.managerTokenAccount)
          : vault.getInvestorTokenAccount(wallet.publicKey);

        output.info(`Vault: ${vaultArg}`);
        output.info(`Repaying: ${amount.toString()} assets`);

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

        const sig = await vault.repay(
          wallet.publicKey,
          amount,
          managerTokenAccount,
        );

        spinner.succeed("Transaction confirmed");
        output.success(`Repaid: ${amount.toString()} assets`);
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "repay",
            amount: amount.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Repay failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
