/** compliance init-sanctions-list — Initialize the singleton SanctionsList PDA */

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

export function registerInitSanctionsListCommand(parent: Command): void {
  parent
    .command("init-sanctions-list")
    .description("Initialize the singleton SanctionsList PDA")
    .option(
      "--authority <pubkey>",
      "Sanctions-list authority (defaults to wallet pubkey)",
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
        const authority = opts.authority
          ? new PublicKey(opts.authority)
          : wallet.publicKey;
        const [sanctionsList] = getSanctionsListAddress(programId);

        output.info("═══ Compliance: Initialize Sanctions List ═══");
        output.info(`  Program ID:      ${programId.toBase58()}`);
        output.info(`  SanctionsList:   ${sanctionsList.toBase58()}`);
        output.info(`  Authority:       ${authority.toBase58()}`);
        output.info(`  Payer:           ${wallet.publicKey.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm(
            "Proceed with initializing the sanctions list?",
          );
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Initializing sanctions list...");
        spinner.start();

        const hook = await ComplianceHook.create(prog, { authority });

        spinner.succeed("Sanctions list initialized!");
        output.success(
          `SanctionsList PDA: ${hook.sanctionsListPda.toBase58()}`,
        );

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            sanctionsList: hook.sanctionsListPda.toBase58(),
            authority: authority.toBase58(),
            programId: programId.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Initialize sanctions list failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
