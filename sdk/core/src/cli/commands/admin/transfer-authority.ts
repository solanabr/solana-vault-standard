/** Transfer Authority Command - Transfer vault ownership to new authority */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { formatAddress } from "../../output";
import {
  isAllocatorVariant,
  loadVaultClient,
  resolveVaultArg,
  checkAuthority,
} from "../../utils";
import { AllocatorVaultClient } from "../../../svs9";
import { SolanaVault } from "../../../vault";

export function registerTransferAuthorityCommand(program: Command): void {
  program
    .command("transfer-authority")
    .description("Transfer vault authority to a new address (admin only)")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--new-authority <pubkey>", "New authority address")
    .option("--variant <variant>", "SVS variant (for raw vault addresses)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, provider, wallet, options } = ctx;

      let newAuthority: PublicKey;
      try {
        newAuthority = new PublicKey(opts.newAuthority);
      } catch {
        output.error(`Invalid new authority address: ${opts.newAuthority}`);
        process.exit(1);
      }

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      try {
        const vault = await loadVaultClient(provider, resolved);
        const state = await vault.getState();

        if (!checkAuthority(wallet.publicKey, state.authority, output)) {
          process.exit(1);
        }

        if (state.authority.equals(newAuthority)) {
          output.warn("New authority is the same as current authority.");
          return;
        }

        output.warn("AUTHORITY TRANSFER");
        output.info(`Vault: ${vaultArg}`);
        output.info(
          `Current: ${formatAddress(state.authority.toBase58(), false)}`,
        );
        output.info(
          `New:     ${formatAddress(newAuthority.toBase58(), false)}`,
        );
        output.warn("This action is IRREVERSIBLE.");

        if (options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          if (globalOpts.output === "json") {
            output.json({
              dryRun: true,
              vault: vaultArg,
              operation: "transfer-authority",
              currentAuthority: state.authority.toBase58(),
              newAuthority: newAuthority.toBase58(),
            });
          }
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm(
            "Are you SURE you want to transfer authority?",
          );
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Transferring authority...");
        spinner.start();

        const signature = isAllocatorVariant(resolved.variant)
          ? await (vault as AllocatorVaultClient).transferAuthority(
              newAuthority,
            )
          : await (vault as SolanaVault).transferAuthority(
              wallet.publicKey,
              newAuthority,
            );

        spinner.succeed("Authority transferred");
        output.info(`New authority: ${newAuthority.toBase58()}`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "transfer-authority",
            previousAuthority: state.authority.toBase58(),
            newAuthority: newAuthority.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Transfer failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
