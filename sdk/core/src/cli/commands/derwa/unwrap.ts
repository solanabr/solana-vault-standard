/** derwa unwrap — unwrap dePOOL back to cPOOL (attestation-gated) */

import { Command } from "commander";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, type AccountMeta } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { DeRwaWrapper } from "../../../derwa-wrapper";
import { loadIdl } from "../../utils";

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

export function registerUnwrapCommand(parent: Command): void {
  parent
    .command("unwrap")
    .description(
      "Unwrap dePOOL back to cPOOL 1:1 (requires a valid attestation on the destination)",
    )
    .requiredOption("--amount <u64>", "Amount of dePOOL to unwrap (raw u64)")
    .requiredOption(
      "--attestation <pubkey>",
      "Attestation PDA proving the destination wallet is qualified to hold cPOOL",
    )
    .option(
      "--remaining-accounts <pubkeys>",
      "Comma-separated hook extra accounts for the cPOOL transfer CPI (readonly, non-signer)",
    )
    .action(async (opts) => {
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
        "derwa_wrapper.json",
      );
      if (!fs.existsSync(idlPath)) {
        output.error(
          "derwa-wrapper IDL not found. Run `anchor build -p derwa_wrapper` first.",
        );
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const amount = new BN(opts.amount);
        const attestation = new PublicKey(opts.attestation);
        const remainingAccounts = parseReadonlyAccounts(opts.remainingAccounts);

        output.info("═══ deRWA Wrapper: Unwrap ═══");
        output.info(`  User:         ${wallet.publicKey.toBase58()}`);
        output.info(`  Amount:       ${amount.toString()} dePOOL → cPOOL`);
        output.info(`  Attestation:  ${attestation.toBase58()}`);
        output.info(`  Hook extras:  ${remainingAccounts.length}`);

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

        const spinner = output.spinner("Unwrapping dePOOL → cPOOL...");
        spinner.start();

        const sig = await DeRwaWrapper.unwrap(prog, {
          user: wallet.publicKey,
          amount,
          attestation,
          remainingAccounts,
        });

        spinner.succeed(`Unwrapped ${amount.toString()} dePOOL → cPOOL`);
        output.success(`Tx: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            user: wallet.publicKey.toBase58(),
            amount: amount.toString(),
            attestation: attestation.toBase58(),
            signature: sig,
          });
        }
      } catch (error) {
        output.error(
          `Unwrap failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
