/** Pause Command - Emergency pause vault operations (admin only) */

import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolanaVault } from "../../../vault";
import {
  findIdlPath,
  loadIdl,
  resolveVaultArg,
  checkAuthority,
} from "../../utils";

export function registerPauseCommand(program: Command): void {
  program
    .command("pause")
    .description("Emergency pause a vault (admin only)")
    .argument("<vault>", "Vault address or alias")
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

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await SolanaVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );
        const state = await vault.getState();

        if (state.paused) {
          output.warn("Vault is already paused.");
          return;
        }

        if (!checkAuthority(wallet.publicKey, state.authority, output)) {
          process.exit(1);
        }

        output.warn("EMERGENCY PAUSE");
        output.info(`Vault: ${vaultArg}`);
        output.info("This will prevent all deposits and withdrawals.");

        if (options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm(
            "Proceed with emergency pause?",
          );
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Pausing vault...");
        spinner.start();

        const signature = await vault.pause(wallet.publicKey);

        spinner.succeed("Vault paused");
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "pause",
          });
        }
      } catch (error) {
        output.error(
          `Pause failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
