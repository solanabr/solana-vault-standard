/** compliance update-sanctions-list — add or remove addresses on the sanctions list */

import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { ComplianceHook } from "../../../compliance-hook";
import { getSanctionsListAddress } from "../../../compliance-hook-pda";
import { loadIdl } from "../../utils";

function parsePubkeyList(input: string | undefined): PublicKey[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => new PublicKey(s));
}

export function registerUpdateSanctionsListCommand(parent: Command): void {
  parent
    .command("update-sanctions-list")
    .description("Add or remove addresses on the SanctionsList PDA")
    .option("--add <pubkeys>", "Comma-separated addresses to ADD", "")
    .option("--remove <pubkeys>", "Comma-separated addresses to REMOVE", "")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const additions = parsePubkeyList(opts.add);
      const removals = parsePubkeyList(opts.remove);
      if (additions.length === 0 && removals.length === 0) {
        output.error("Must specify at least one of --add or --remove.");
        process.exit(1);
      }

      const idlPath = path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "target",
        "idl",
        "compliance_hook.json",
      );
      if (!fs.existsSync(idlPath)) {
        output.error(
          "compliance-hook IDL not found. Run `anchor build -p compliance_hook` first.",
        );
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const programId = new PublicKey((idl as any).address);
        const [sanctionsList] = getSanctionsListAddress(programId);

        output.info("═══ Compliance: Update Sanctions List ═══");
        output.info(`  SanctionsList: ${sanctionsList.toBase58()}`);
        output.info(`  Authority:     ${wallet.publicKey.toBase58()}`);
        output.info(`  Add:           ${additions.length} address(es)`);
        output.info(`  Remove:        ${removals.length} address(es)`);

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

        const hook = await ComplianceHook.load(prog);
        const sigs: string[] = [];

        if (additions.length > 0 || removals.length > 0) {
          const spinner = output.spinner("Updating sanctions list...");
          spinner.start();
          const sig = await hook.updateSanctionsList({
            authority: wallet,
            additions,
            removals,
          });
          spinner.succeed(
            `Sanctions list updated (+${additions.length}, -${removals.length})`,
          );
          sigs.push(sig);
        }

        for (const sig of sigs) output.success(`Tx: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            sanctionsList: sanctionsList.toBase58(),
            additions: additions.map((p) => p.toBase58()),
            removals: removals.map((p) => p.toBase58()),
            signatures: sigs,
          });
        }
      } catch (error) {
        output.error(
          `Update sanctions list failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
