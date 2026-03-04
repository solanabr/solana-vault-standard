/** Preview Command - Preview vault operations without executing transactions */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolanaVault } from "../../../vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

export function registerPreviewCommand(program: Command): void {
  program
    .command("preview")
    .description("Preview vault operations without executing")
    .argument("<vault>", "Vault address or alias")
    .argument("<operation>", "Operation: deposit, mint, withdraw, redeem")
    .argument("<amount>", "Amount (in raw units)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, operation, amountStr, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const amount = new BN(amountStr);
      const validOps = ["deposit", "mint", "withdraw", "redeem"];
      if (!validOps.includes(operation)) {
        output.error(
          `Unknown operation: ${operation}. Use: ${validOps.join(", ")}`,
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
        const vault = await SolanaVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        let result: BN;
        let description: string;

        switch (operation) {
          case "deposit":
            result = await vault.previewDeposit(amount);
            description = `Deposit ${amount.toString()} assets → receive ${result.toString()} shares`;
            break;
          case "mint":
            result = await vault.previewMint(amount);
            description = `Mint ${amount.toString()} shares → costs ${result.toString()} assets`;
            break;
          case "withdraw":
            result = await vault.previewWithdraw(amount);
            description = `Withdraw ${amount.toString()} assets → burns ${result.toString()} shares`;
            break;
          case "redeem":
            result = await vault.previewRedeem(amount);
            description = `Redeem ${amount.toString()} shares → receive ${result.toString()} assets`;
            break;
          default:
            throw new Error(`Unknown operation: ${operation}`);
        }

        if (globalOpts.output === "json") {
          output.json({
            operation,
            input: amount.toString(),
            output: result.toString(),
            vault: vaultArg,
          });
        } else {
          output.success(description);
        }
      } catch (error) {
        output.error(
          `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
