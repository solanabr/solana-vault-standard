import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { AsyncVault } from "../../../async-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

const U64_MAX = "18446744073709551615";

function parseOraclePrice(value: string): BN {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      "--oracle-price must be a positive integer (no decimals, negatives, or non-numeric characters)",
    );
  }
  if (
    value.length > U64_MAX.length ||
    (value.length === U64_MAX.length && value > U64_MAX)
  ) {
    throw new Error(`--oracle-price exceeds u64 max (${U64_MAX})`);
  }
  return new BN(value);
}

export function registerFulfillRedeemCommand(program: Command): void {
  program
    .command("fulfill-redeem")
    .description("Fulfill a pending redeem request (operator only)")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--owner <pubkey>", "Owner of the redeem request")
    .option("--oracle-price <number>", "Oracle price for conversion")
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

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await AsyncVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        output.info(`Vault: ${vaultArg}`);
        output.info(`Fulfilling redeem for owner: ${owner.toBase58()}`);

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

        const sig = await vault.fulfillRedeem(wallet.publicKey, {
          owner,
          oraclePrice: opts.oraclePrice
            ? parseOraclePrice(opts.oraclePrice)
            : undefined,
        });

        spinner.succeed("Transaction confirmed");
        output.success(`Redeem fulfilled for ${owner.toBase58()}`);
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "fulfill-redeem",
            owner: owner.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Fulfill redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
