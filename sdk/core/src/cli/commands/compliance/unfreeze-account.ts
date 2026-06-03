/** compliance unfreeze-account — close a global FrozenAccount PDA for an owner */

import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { ComplianceHook } from "../../../compliance-hook";
import {
  getComplianceFrozenAccountAddress,
  getSanctionsListAddress,
} from "../../../compliance-hook-pda";
import { loadIdl } from "../../utils";

export function registerUnfreezeAccountCommand(parent: Command): void {
  parent
    .command("unfreeze-account")
    .description("Unfreeze an owner across all compliance-hook-bound mints")
    .requiredOption("--owner <pubkey>", "Source/destination owner to unfreeze")
    .option(
      "--rent-recipient <pubkey>",
      "Account receiving rent from the closed FrozenAccount PDA (defaults to authority)",
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
        const owner = new PublicKey(opts.owner);
        const rentRecipient = opts.rentRecipient
          ? new PublicKey(opts.rentRecipient)
          : wallet.publicKey;
        const [sanctionsList] = getSanctionsListAddress(programId);
        const [frozenAccount] = getComplianceFrozenAccountAddress(
          owner,
          programId,
        );

        output.info("═══ Compliance: Unfreeze Account ═══");
        output.info(`  SanctionsList:  ${sanctionsList.toBase58()}`);
        output.info(`  Owner:          ${owner.toBase58()}`);
        output.info(`  FrozenAccount:  ${frozenAccount.toBase58()}`);
        output.info(`  RentRecipient:  ${rentRecipient.toBase58()}`);
        output.info(`  Authority:      ${wallet.publicKey.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Unfreeze this owner?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const hook = await ComplianceHook.load(prog);
        const spinner = output.spinner("Closing FrozenAccount PDA...");
        spinner.start();
        const signature = await hook.unfreezeAccount({
          authority: wallet,
          owner,
          rentRecipient,
        });
        spinner.succeed("Owner unfrozen");
        output.success(`Tx: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            sanctionsList: sanctionsList.toBase58(),
            owner: owner.toBase58(),
            frozenAccount: frozenAccount.toBase58(),
            rentRecipient: rentRecipient.toBase58(),
            signature,
          });
        }
      } catch (error) {
        output.error(
          `Unfreeze account failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
