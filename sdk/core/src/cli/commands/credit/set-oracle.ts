import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { CreditVault } from "../../../credit-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerSetOracleCommand(program: Command): void {
  program
    .command("set-oracle")
    .description("Repoint the vault's NAV oracle (authority only, immediate)")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--new-oracle <pubkey>", "New oracle account")
    .requiredOption(
      "--new-oracle-program <pubkey>",
      "Program that owns the new oracle account",
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

      const newOracle = new PublicKey(opts.newOracle);
      const newOracleProgram = new PublicKey(opts.newOracleProgram);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await CreditVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        output.info(`Vault: ${vaultArg}`);
        output.info(`New oracle: ${newOracle.toBase58()}`);
        output.info(`New oracle program: ${newOracleProgram.toBase58()}`);

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

        const sig = await vault.setOracle(
          wallet.publicKey,
          newOracle,
          newOracleProgram,
        );

        spinner.succeed("Transaction confirmed");
        output.success(`Oracle repointed to ${newOracle.toBase58()}`);
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "set-oracle",
            newOracle: newOracle.toBase58(),
            newOracleProgram: newOracleProgram.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Set oracle failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
