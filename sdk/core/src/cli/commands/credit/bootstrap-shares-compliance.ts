import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { CreditVault } from "../../../credit-vault";
import { ComplianceMode } from "../../../compliance-hook";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

/**
 * `credit bootstrap-shares-compliance` — initialize the compliance-hook
 * `MintConfig` + `ExtraAccountMetaList` PDAs for a CreditVault's cPOOL
 * shares mint. Operator-runbook step that runs ONCE per pool, after
 * `credit init` (initialize_pool).
 *
 * The on-chain handler CPIs into compliance-hook with `vault_seeds`
 * so the vault PDA — which is the cPOOL mint authority — satisfies
 * compliance-hook's `Signer == mint_authority` constraint via
 * Anchor's `invoke_signed` flow. See the corresponding instruction
 * doc-comment in `programs/svs-11/src/instructions/bootstrap_shares_compliance.rs`
 * for the full architectural rationale.
 *
 * For Permissioned mode, the operator must ALSO issue an
 * infrastructure attestation for the vault PDA via the configured
 * attestation program (subject = `vault.key()`). This CLI does NOT
 * issue that attestation — operators run a separate
 * `mock-sas createAttestation` (or equivalent SAS / Civic Pass call)
 * with the vault's pubkey as subject. The runbook documentation
 * spells this out at `docs/SVS-11.md::Pool Setup`.
 */
export function registerBootstrapSharesComplianceCommand(
  program: Command,
): void {
  program
    .command("bootstrap-shares-compliance")
    .description(
      "Initialize compliance-hook MintConfig + EAML for a CreditVault's cPOOL (operator runbook step, one-shot per pool)",
    )
    .argument("<vault>", "Vault address or alias")
    .requiredOption(
      "--mode <mode>",
      "Compliance mode for cPOOL transfers: freely-transferable | permissioned",
    )
    .option(
      "--pool-policy <pubkey>",
      "Pool policy PDA — REQUIRED for `--mode permissioned`; must NOT be set for freely-transferable",
    )
    .option(
      "--attestation-program <pubkey>",
      "Program owning acceptable attestation accounts (mock-sas / SAS / Civic Pass) — REQUIRED non-default for permissioned",
    )
    .option(
      "--attestation-issuer <pubkey>",
      "Expected `issuer` field on attestation payloads — REQUIRED non-default for permissioned",
    )
    .option(
      "--required-attestation-type <u8>",
      "Required `attestation_type` byte (e.g. 0 = generic KYC, 2 = accredited investor)",
      "0",
    )
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, provider, wallet, options } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

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

      // Mode-coherent flag validation — mirror the on-chain
      // `MissingPoolPolicyForPermissioned` /
      // `PoolPolicySetOnFreelyTransferable` invariants so operators
      // get a fast-fail error rather than a runtime tx rejection.
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

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await CreditVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );
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

        output.info("═══ SVS-11: Bootstrap Shares Compliance ═══");
        output.info(`  Vault:                ${vaultArg}`);
        output.info(`  Mode:                 ${modeStr}`);
        output.info(
          `  Pool policy:          ${poolPolicy ? poolPolicy.toBase58() : "(none)"}`,
        );
        output.info(`  Attestation program:  ${attestationProgram.toBase58()}`);
        output.info(`  Attestation issuer:   ${attestationIssuer.toBase58()}`);
        output.info(`  Required type:        ${requiredAttestationType}`);
        output.info(`  Authority:            ${wallet.publicKey.toBase58()}`);

        if (isPermissioned) {
          output.warn(
            "REMINDER: For Permissioned mode, you MUST also issue a system attestation for the vault PDA (subject = vault.key()) via the configured attestation program. See docs/SVS-11.md.",
          );
        }

        if (options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Proceed?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner(
          "CPI'ing into compliance-hook (init MintConfig + EAML)...",
        );
        spinner.start();

        const sig = await vault.bootstrapSharesCompliance(wallet.publicKey, {
          mode,
          poolPolicy,
          attestationProgram,
          attestationIssuer,
          requiredAttestationType,
        });

        spinner.succeed(
          "MintConfig + ExtraAccountMetaList initialized for cPOOL",
        );
        output.success(`Tx: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "bootstrap-shares-compliance",
            mode: modeStr,
            poolPolicy: poolPolicy ? poolPolicy.toBase58() : null,
            attestationProgram: attestationProgram.toBase58(),
            attestationIssuer: attestationIssuer.toBase58(),
            requiredAttestationType,
          });
        }
      } catch (error) {
        output.error(
          `Bootstrap shares compliance failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
