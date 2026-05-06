/** derwa init — bind a pool to a (cPOOL, dePOOL) mint pair via the wrapper */

import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { DeRwaWrapper } from "../../../derwa-wrapper";
import { loadIdl } from "../../utils";

export function registerInitDerwaCommand(parent: Command): void {
  parent
    .command("init")
    .description("Bind pool ↔ permissioned (cPOOL) ↔ open (dePOOL) into a WrapperConfig")
    .argument("<pool>", "Pool PDA (CreditVault address)")
    .requiredOption(
      "--permissioned-mint <pubkey>",
      "Closed/permissioned mint (cPOOL) — typically the SVS-11 shares mint",
    )
    .requiredOption(
      "--derwa-mint <pubkey>",
      "Open Token-2022 mint (dePOOL) with TransferHook bound to compliance-hook",
    )
    .requiredOption(
      "--attestation-program <pubkey>",
      "Program owning attestation accounts (mock-sas / SAS / Civic Pass)",
    )
    .requiredOption(
      "--attestation-issuer <pubkey>",
      "Expected attestation issuer for this pool's destination wallets",
    )
    .option(
      "--required-attestation-type <u8>",
      "Required attestation_type byte (e.g. 0 = generic KYC, 2 = accredited)",
      "0",
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
        const pool = new PublicKey(poolArg);
        const permissionedMint = new PublicKey(opts.permissionedMint);
        const derwaMint = new PublicKey(opts.derwaMint);
        const attestationProgram = new PublicKey(opts.attestationProgram);
        const attestationIssuer = new PublicKey(opts.attestationIssuer);
        const requiredAttestationType = parseInt(
          opts.requiredAttestationType ?? "0",
          10,
        );

        output.info("═══ deRWA Wrapper: Initialize ═══");
        output.info(`  Pool:                 ${pool.toBase58()}`);
        output.info(`  Permissioned mint:    ${permissionedMint.toBase58()} (cPOOL)`);
        output.info(`  deRWA mint:           ${derwaMint.toBase58()} (dePOOL)`);
        output.info(`  Attestation program:  ${attestationProgram.toBase58()}`);
        output.info(`  Attestation issuer:   ${attestationIssuer.toBase58()}`);
        output.info(`  Required type:        ${requiredAttestationType}`);
        output.info(`  Payer:                ${wallet.publicKey.toBase58()}`);

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

        const spinner = output.spinner("Creating WrapperConfig PDA...");
        spinner.start();

        const result = await DeRwaWrapper.initialize(
          prog,
          wallet.publicKey,
          {
            pool,
            permissionedMint,
            derwaMint,
            attestationProgram,
            attestationIssuer,
            requiredAttestationType,
          },
        );

        spinner.succeed("WrapperConfig created");
        output.success(`Tx: ${result.signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            pool: pool.toBase58(),
            wrapperConfig: result.wrapperConfig.toBase58(),
            permissionedMint: permissionedMint.toBase58(),
            derwaMint: derwaMint.toBase58(),
            attestationProgram: attestationProgram.toBase58(),
            attestationIssuer: attestationIssuer.toBase58(),
            requiredAttestationType,
            signature: result.signature,
          });
        }
      } catch (error) {
        output.error(
          `Initialize wrapper failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
