import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { CreditVault } from "../../../credit-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

/**
 * Two-step authority rotation for a CreditVault. The safe path:
 *   1. current authority: `request-transfer-authority --new-authority <pk>`
 *   2. new authority:     `accept-authority`
 * `cancel-transfer-authority` clears a pending request. The legacy single-step
 * `transfer-authority` is intentionally NOT exposed here — prefer the two-step
 * flow, which proves the incoming key controls its signer before the swap.
 */
async function loadVault(
  program: Command,
  vaultArg: string,
  opts: Record<string, string>,
) {
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

  const idl = loadIdl(idlPath);
  const prog = new Program(idl as any, provider);
  const vault = await CreditVault.load(
    prog,
    resolved.assetMint,
    resolved.vaultId,
  );
  return { vault, output, wallet, options, globalOpts };
}

export function registerAuthorityCommands(program: Command): void {
  program
    .command("request-transfer-authority")
    .description(
      "Step 1/2: nominate a new authority as pending (current authority only)",
    )
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--new-authority <pubkey>", "Address to nominate")
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, output, wallet, options, globalOpts } = await loadVault(
        program,
        vaultArg,
        opts,
      );
      const newAuthority = new PublicKey(opts.newAuthority);

      output.info(`Vault: ${vaultArg}`);
      output.info(`Pending authority: ${newAuthority.toBase58()}`);
      output.warn("The nominee must run `accept-authority` to complete it.");

      if (options.dryRun) {
        output.success("Dry run complete.");
        return;
      }
      if (!options.yes && !(await output.confirm("Proceed?"))) {
        output.warn("Aborted.");
        return;
      }

      try {
        const sig = await vault.requestTransferAuthority(
          wallet.publicKey,
          newAuthority,
        );
        output.success(`Pending authority set to ${newAuthority.toBase58()}`);
        output.info(`Signature: ${sig}`);
        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "request-transfer-authority",
            pendingAuthority: newAuthority.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Request transfer authority failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  program
    .command("accept-authority")
    .description(
      "Step 2/2: accept a pending authority transfer (nominee signs)",
    )
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, output, wallet, options, globalOpts } = await loadVault(
        program,
        vaultArg,
        opts,
      );

      output.info(`Vault: ${vaultArg}`);
      output.info(`Accepting as: ${wallet.publicKey.toBase58()}`);

      if (options.dryRun) {
        output.success("Dry run complete.");
        return;
      }
      if (!options.yes && !(await output.confirm("Proceed?"))) {
        output.warn("Aborted.");
        return;
      }

      try {
        const sig = await vault.acceptAuthority(wallet.publicKey);
        output.success(`Authority is now ${wallet.publicKey.toBase58()}`);
        output.info(`Signature: ${sig}`);
        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "accept-authority",
            authority: wallet.publicKey.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Accept authority failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  program
    .command("cancel-transfer-authority")
    .description("Clear a pending authority transfer (current authority only)")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, output, wallet, options, globalOpts } = await loadVault(
        program,
        vaultArg,
        opts,
      );

      output.info(`Vault: ${vaultArg}`);
      output.info("Cancelling pending authority transfer");

      if (options.dryRun) {
        output.success("Dry run complete.");
        return;
      }
      if (!options.yes && !(await output.confirm("Proceed?"))) {
        output.warn("Aborted.");
        return;
      }

      try {
        const sig = await vault.cancelTransferAuthority(wallet.publicKey);
        output.success("Pending authority transfer cleared");
        output.info(`Signature: ${sig}`);
        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "cancel-transfer-authority",
          });
        }
      } catch (error) {
        output.error(
          `Cancel transfer authority failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
