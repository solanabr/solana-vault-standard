import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { TranchedVault } from "../../../tranched-vault";
import { findIdlPath, loadIdl } from "../../utils";

export function registerTranchedRedeemCommand(parent: Command): void {
  parent
    .command("redeem")
    .description("Redeem shares from a tranche")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .requiredOption("-t, --tranche <number>", "Tranche index")
    .requiredOption("-s, --shares <number>", "Amount of shares to redeem")
    .option("--min-assets <number>", "Minimum assets to receive", "0")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet, options } = ctx;

      const idlPath = findIdlPath("svs-12");
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const assetMint = new PublicKey(opts.assetMint);
        const vault = await TranchedVault.load(
          prog,
          assetMint,
          new BN(opts.vaultId),
        );

        const trancheIndex = parseInt(opts.tranche);
        const shares = new BN(opts.shares);
        const minAssetsOut = new BN(opts.minAssets);

        output.info(
          `Redeeming ${shares.toString()} shares from tranche ${trancheIndex}`,
        );

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Proceed with redeem?");
          if (!confirmed) return;
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const sig = await vault.redeem(wallet.publicKey, trancheIndex, {
          shares,
          minAssetsOut,
        });

        spinner.succeed("Redeem confirmed");
        output.info(`Signature: ${sig}`);
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
