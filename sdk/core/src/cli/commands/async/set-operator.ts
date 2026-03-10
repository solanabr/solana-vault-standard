import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { AsyncVault } from "../../../async-vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerSetOperatorCommand(program: Command): void {
  program
    .command("set-operator")
    .description("Set or revoke an operator for an SVS-10 vault")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--operator <pubkey>", "Operator address")
    .option("--can-fulfill-deposit", "Allow operator to fulfill deposits", false)
    .option("--can-fulfill-redeem", "Allow operator to fulfill redeems", false)
    .option("--can-claim", "Allow operator to claim on behalf of owner", false)
    .option("--all", "Grant all permissions", false)
    .option("--revoke", "Revoke all permissions", false)
    .option("--program-id <pubkey>", "Program ID")
    .option("--asset-mint <pubkey>", "Asset mint")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, provider, wallet, options } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      const operator = new PublicKey(opts.operator);
      const canFulfillDeposit = opts.all || opts.canFulfillDeposit;
      const canFulfillRedeem = opts.all || opts.canFulfillRedeem;
      const canClaim = opts.all || opts.canClaim;
      const anyApproved = !opts.revoke && (canFulfillDeposit || canFulfillRedeem || canClaim);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await AsyncVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        output.info(`Vault: ${vaultArg}`);
        output.info(`Operator: ${operator.toBase58()}`);
        if (opts.revoke) {
          output.info("Action: Revoke all permissions");
        } else {
          output.info(`Permissions: fulfill_deposit=${canFulfillDeposit} fulfill_redeem=${canFulfillRedeem} claim=${canClaim}`);
        }

        if (options.dryRun) {
          output.success("Dry run complete.");
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Proceed?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const sig = await vault.setOperator(wallet.publicKey, {
          operator,
          canFulfillDeposit: opts.revoke ? false : canFulfillDeposit,
          canFulfillRedeem: opts.revoke ? false : canFulfillRedeem,
          canClaim: opts.revoke ? false : canClaim,
        });

        spinner.succeed("Transaction confirmed");
        output.success(
          `Operator ${anyApproved ? "approved" : "revoked"}: ${operator.toBase58()}`,
        );
        output.info(`Signature: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: sig,
            vault: vaultArg,
            operation: "set-operator",
            operator: operator.toBase58(),
            canFulfillDeposit,
            canFulfillRedeem,
            canClaim,
          });
        }
      } catch (error) {
        output.error(
          `Set operator failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
