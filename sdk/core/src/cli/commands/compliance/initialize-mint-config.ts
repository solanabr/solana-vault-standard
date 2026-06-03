/** compliance init-mint-config — create per-mint MintConfig PDA */

import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { ComplianceHook, ComplianceMode } from "../../../compliance-hook";
import { getMintConfigAddress } from "../../../compliance-hook-pda";
import { loadIdl } from "../../utils";

export function registerInitMintConfigCommand(parent: Command): void {
  parent
    .command("init-mint-config")
    .description("Create the per-mint MintConfig PDA")
    .argument("<mint>", "Token-2022 mint pubkey")
    .requiredOption(
      "--mode <mode>",
      "Compliance mode: freely-transferable | permissioned",
    )
    .option(
      "--pool-policy <pubkey>",
      "Pool policy PDA (REQUIRED if --mode permissioned)",
    )
    .option(
      "--attestation-program <pubkey>",
      "Program owning acceptable attestation accounts (REQUIRED for permissioned)",
    )
    .option(
      "--attestation-issuer <pubkey>",
      "Expected attestation issuer (REQUIRED for permissioned)",
    )
    .option(
      "--required-attestation-type <u8>",
      "Required attestation_type byte (e.g. 0 = generic KYC, 2 = accredited)",
      "0",
    )
    .action(async (mintArg, opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const modeStr = String(opts.mode).toLowerCase();
      let mode: ComplianceMode;
      let isPermissioned: boolean;
      if (
        modeStr === "freely-transferable" ||
        modeStr === "freely_transferable"
      ) {
        mode = ComplianceMode.freelyTransferable();
        isPermissioned = false;
      } else if (modeStr === "permissioned") {
        mode = ComplianceMode.permissioned();
        isPermissioned = true;
      } else {
        output.error(
          `Invalid --mode '${opts.mode}'. Expected 'freely-transferable' or 'permissioned'.`,
        );
        process.exit(1);
      }
      if (isPermissioned && !opts.poolPolicy) {
        output.error("--pool-policy is REQUIRED when --mode is permissioned.");
        process.exit(1);
      }
      if (!isPermissioned && opts.poolPolicy) {
        output.error(
          "--pool-policy must NOT be set when --mode is freely-transferable.",
        );
        process.exit(1);
      }
      if (
        isPermissioned &&
        (!opts.attestationProgram || !opts.attestationIssuer)
      ) {
        output.error(
          "--attestation-program AND --attestation-issuer are REQUIRED when --mode is permissioned.",
        );
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
        const mint = new PublicKey(mintArg);
        const poolPolicy = opts.poolPolicy
          ? new PublicKey(opts.poolPolicy)
          : null;
        const attestationProgram = opts.attestationProgram
          ? new PublicKey(opts.attestationProgram)
          : PublicKey.default;
        const attestationIssuer = opts.attestationIssuer
          ? new PublicKey(opts.attestationIssuer)
          : PublicKey.default;
        const requiredAttestationType = parseInt(
          opts.requiredAttestationType ?? "0",
          10,
        );
        const [mintConfig] = getMintConfigAddress(mint, programId);

        output.info("═══ Compliance: Initialize Mint Config ═══");
        output.info(`  Mint:                ${mint.toBase58()}`);
        output.info(`  MintConfig:          ${mintConfig.toBase58()}`);
        output.info(`  Mode:                ${modeStr}`);
        output.info(
          `  Pool policy:         ${poolPolicy ? poolPolicy.toBase58() : "(none)"}`,
        );
        output.info(`  Attestation program: ${attestationProgram.toBase58()}`);
        output.info(`  Attestation issuer:  ${attestationIssuer.toBase58()}`);
        output.info(`  Required type:       ${requiredAttestationType}`);
        output.info(
          `  MintAuthority:       ${wallet.publicKey.toBase58()} (signer)`,
        );

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

        const spinner = output.spinner("Creating MintConfig PDA...");
        spinner.start();

        const result = await ComplianceHook.initializeMintConfig(prog, {
          mint,
          mode,
          poolPolicy,
          attestationProgram,
          attestationIssuer,
          requiredAttestationType,
          mintAuthority: wallet,
        });

        spinner.succeed("MintConfig created");
        output.success(`Tx: ${result.signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            mint: mint.toBase58(),
            mintConfig: result.mintConfig.toBase58(),
            mode: modeStr,
            poolPolicy: poolPolicy ? poolPolicy.toBase58() : null,
            attestationProgram: attestationProgram.toBase58(),
            attestationIssuer: attestationIssuer.toBase58(),
            requiredAttestationType,
            signature: result.signature,
          });
        }
      } catch (error) {
        output.error(
          `Initialize mint config failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
