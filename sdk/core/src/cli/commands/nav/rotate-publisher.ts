/** nav rotate-publisher — swap the publisher key on a NavAccount */

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

export function registerRotatePublisherCommand(parent: Command): void {
  parent
    .command("rotate-publisher")
    .description(
      "Rotate the publisher pubkey on a NavAccount (caller must be key_rotation_authority)",
    )
    .argument("<pool>", "Pool PDA (CreditVault address)")
    .requiredOption("--new-publisher <pubkey>", "New publisher pubkey")
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
        const newPublisher = new PublicKey(opts.newPublisher);
        const [navAccount] = getNavAccountAddress(pool, programId);

        output.info("═══ NavOracle: Rotate Publisher ═══");
        output.info(`  Pool:               ${pool.toBase58()}`);
        output.info(`  NavAccount:         ${navAccount.toBase58()}`);
        output.info(`  New publisher:      ${newPublisher.toBase58()}`);
        output.info(`  Rotation authority: ${wallet.publicKey.toBase58()} (signer)`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with rotation?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Rotating publisher...");
        spinner.start();

        const sig = await NavOracle.rotatePublisher(
          prog,
          wallet.publicKey,
          { pool, newPublisher },
        );

        spinner.succeed("Publisher rotated");
        output.success(`Tx: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            pool: pool.toBase58(),
            navAccount: navAccount.toBase58(),
            newPublisher: newPublisher.toBase58(),
            signature: sig,
          });
        }
      } catch (error) {
        output.error(
          `Rotate publisher failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
