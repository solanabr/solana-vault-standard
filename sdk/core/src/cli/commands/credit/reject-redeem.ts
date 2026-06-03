import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, type AccountMeta } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { CreditVault } from "../../../credit-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

// reject_redeem moves cPOOL from the vault's redemption_escrow back to the
// investor (same escrow→investor direction as cancel_redeem), so the readonly
// hook-extras flag shape is identical.
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

export function registerRejectRedeemCommand(program: Command): void {
  program
    .command("reject-redeem")
    .description(
      "Reject a pending redemption request, returning escrowed shares (manager only)",
    )
    .argument("<vault>", "Vault address or alias")
    .requiredOption(
      "--investor <pubkey>",
      "Investor who requested the redemption",
    )
    .option("--reason-code <number>", "Reason code recorded on rejection", "0")
    .option(
      "--remaining-accounts <pubkeys>",
      "Comma-separated hook extra accounts for the cPOOL escrow→investor transfer CPI (readonly, non-signer; required when cPOOL has an active TransferHook)",
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

      const investor = new PublicKey(opts.investor);
      const reasonCode = Number(opts.reasonCode);

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
        output.info(
          `Rejecting redemption for investor: ${investor.toBase58()}`,
        );
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

        const sig = await vault.rejectRedeem(
          wallet.publicKey,
          investor,
          reasonCode,
          remainingAccounts,
        );

        spinner.succeed("Transaction confirmed");
        output.success(`Redemption rejected for ${investor.toBase58()}`);
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "reject-redeem",
            investor: investor.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Reject redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
