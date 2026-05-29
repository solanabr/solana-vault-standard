/** nav init — create the per-pool NavAccount PDA */

import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { NavOracle } from "../../../nav-oracle";
import { getNavAccountAddress } from "../../../nav-oracle-pda";
import { loadIdl } from "../../utils";

export function registerInitNavAccountCommand(parent: Command): void {
  parent
    .command("init")
    .description("Create the per-pool NavAccount PDA in the nav-oracle program")
    .argument("<pool>", "Pool PDA (CreditVault address)")
    .requiredOption(
      "--publisher <pubkey>",
      "Publisher key authorized to sign NAV updates",
    )
    .option(
      "--max-deviation-bps <number>",
      "Max consecutive-publish NAV deviation in bps (> 0)",
      "500",
    )
    .action(async (poolArg, opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const idlPath = path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "target",
        "idl",
        "nav_oracle.json",
      );
      if (!fs.existsSync(idlPath)) {
        output.error(
          "nav-oracle IDL not found. Run `anchor build -p nav_oracle` first.",
        );
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const programId = new PublicKey((idl as any).address);
        const pool = new PublicKey(poolArg);
        const publisher = new PublicKey(opts.publisher);
        const [navAccount] = getNavAccountAddress(pool, programId);

        output.info("═══ NavOracle: Initialize NavAccount ═══");
        output.info(`  Pool:               ${pool.toBase58()}`);
        output.info(`  NavAccount:         ${navAccount.toBase58()}`);
        output.info(`  Publisher:          ${publisher.toBase58()}`);
        output.info(`  Pool authority:     ${wallet.publicKey.toBase58()}`);
        output.info(`  Payer:              ${wallet.publicKey.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Creating NavAccount PDA...");
        spinner.start();

        const result = await NavOracle.initialize(prog, wallet.publicKey, {
          pool,
          publisher,
          poolAuthority: wallet.publicKey,
          maxDeviationBps: Number(opts.maxDeviationBps),
        });

        spinner.succeed("NavAccount created");
        output.success(`Tx: ${result.signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            pool: pool.toBase58(),
            navAccount: result.navAccount.toBase58(),
            publisher: publisher.toBase58(),
            signature: result.signature,
          });
        }
      } catch (error) {
        output.error(
          `Initialize NavAccount failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
