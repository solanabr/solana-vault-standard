/** compliance init-eaml — create the ExtraAccountMetaList PDA for a mint */

import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { ComplianceHook } from "../../../compliance-hook";
import { getExtraAccountMetaListAddress } from "../../../compliance-hook-pda";
import { loadIdl } from "../../utils";

export function registerInitEamlCommand(parent: Command): void {
  parent
    .command("init-eaml")
    .description(
      "Create the Token-2022 ExtraAccountMetaList PDA for a mint (must run AFTER init-mint-config)",
    )
    .argument("<mint>", "Token-2022 mint pubkey")
    .action(async (mintArg, opts) => {
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
        const mint = new PublicKey(mintArg);
        const [eaml] = getExtraAccountMetaListAddress(mint, programId);

        output.info("═══ Compliance: Initialize ExtraAccountMetaList ═══");
        output.info(`  Mint:          ${mint.toBase58()}`);
        output.info(`  EAML:          ${eaml.toBase58()}`);
        output.info(`  MintAuthority: ${wallet.publicKey.toBase58()} (signer)`);

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

        const spinner = output.spinner("Creating ExtraAccountMetaList PDA...");
        spinner.start();

        const result = await ComplianceHook.initializeExtraAccountMetaList(
          prog,
          {
            mint,
            mintAuthority: wallet,
          },
        );

        spinner.succeed("EAML created");
        output.success(`Tx: ${result.signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            mint: mint.toBase58(),
            extraAccountMetaList: result.extraAccountMetaList.toBase58(),
            signature: result.signature,
          });
        }
      } catch (error) {
        output.error(
          `Initialize EAML failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
