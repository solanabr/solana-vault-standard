import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { AsyncVault } from "../../../async-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerClaimRedeemCommand(program: Command): void {
  program
    .command("claim-redeem")
    .description("Claim assets from a fulfilled redemption")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--owner <pubkey>", "Owner of the redeem request")
    .requiredOption("--receiver <pubkey>", "Receiver of the assets")
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

      const owner = new PublicKey(opts.owner);
      const receiver = new PublicKey(opts.receiver);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await AsyncVault.load(prog, resolved.assetMint, resolved.vaultId);

        output.info(`Vault: ${vaultArg}`);
        output.info(`Claiming redeem for owner: ${owner.toBase58()}`);
        output.info(`Receiver: ${receiver.toBase58()}`);

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Proceed?");
          if (!confirmed) { output.warn("Aborted."); return; }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const sig = await vault.claimRedeem(wallet.publicKey, { owner, receiver });

        spinner.succeed("Transaction confirmed");
        output.success(`Redeem claimed for ${owner.toBase58()}`);
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({ success: true, signature: sig, vault: vaultArg, operation: "claim-redeem", owner: owner.toBase58(), receiver: receiver.toBase58() });
        }
      } catch (error) {
        output.error(`Claim redeem failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
