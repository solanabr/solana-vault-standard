import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, type AccountMeta } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { CreditVault } from "../../../credit-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

/// Mirror of `request-redeem.ts::parseReadonlyAccounts` — keeps the
/// `--remaining-accounts` flag shape identical across the redemption
/// CLI surface so operators don't have to remember per-command
/// idiosyncrasies.
function parseReadonlyAccounts(input: string | undefined): AccountMeta[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((pubkey) => ({
      pubkey: new PublicKey(pubkey),
      isSigner: false,
      isWritable: false,
    }));
}

export function registerCancelRedeemCommand(program: Command): void {
  program
    .command("cancel-redeem")
    .description("Cancel a pending redemption request")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
    .option("--vault-id <number>", "Vault ID", "1")
    .option(
      "--remaining-accounts <pubkeys>",
      // Direction-specific note: cancel_redeem moves cPOOL from the
      // vault's redemption_escrow back to the investor, so the EAML
      // extras must resolve attestation PDAs for
      // `(source = vault, destination = investor)` — opposite of
      // request_redeem. The off-chain SDK's `resolveHookExtras` helper
      // handles this when called with the right source/dest owners.
      "Comma-separated hook extra accounts for the cPOOL escrow→investor transfer CPI (readonly, non-signer; required when cPOOL has an active TransferHook)",
    )
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
        const vault = await CreditVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );
        const remainingAccounts = parseReadonlyAccounts(opts.remainingAccounts);

        output.info(`Vault: ${vaultArg}`);
        output.info("Cancelling redemption request");
        if (remainingAccounts.length > 0) {
          output.info(`Hook extras: ${remainingAccounts.length}`);
        }

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

        const sig = await vault.cancelRedeem(
          wallet.publicKey,
          remainingAccounts,
        );

        spinner.succeed("Transaction confirmed");
        output.success("Redemption request cancelled");
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "cancel-redeem",
          });
        }
      } catch (error) {
        output.error(
          `Cancel redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
