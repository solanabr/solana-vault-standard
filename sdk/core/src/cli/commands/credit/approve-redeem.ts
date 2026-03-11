import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { CreditVault } from "../../../credit-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerApproveRedeemCommand(program: Command): void {
  program
    .command("approve-redeem")
    .description("Approve a pending redemption request (manager only)")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--investor <pubkey>", "Investor who requested the redeem")
    .requiredOption("--nav-oracle <pubkey>", "NAV oracle account")
    .requiredOption("--attestation <pubkey>", "SAS attestation account")
    .option("--frozen-check <pubkey>", "Frozen account check (optional)")
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
      const navOracle = new PublicKey(opts.navOracle);
      const attestation = new PublicKey(opts.attestation);
      const frozenCheck = opts.frozenCheck
        ? new PublicKey(opts.frozenCheck)
        : undefined;

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await CreditVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        output.info(`Vault: ${vaultArg}`);
        output.info(`Approving redeem for investor: ${investor.toBase58()}`);

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

        const sig = await vault.approveRedeem(
          wallet.publicKey,
          investor,
          navOracle,
          attestation,
          frozenCheck,
        );

        spinner.succeed("Transaction confirmed");
        output.success(`Redeem approved for ${investor.toBase58()}`);
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "approve-redeem",
            investor: investor.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Approve redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
