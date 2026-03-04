/** Batch Command - Execute multiple vault operations from a YAML file */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as yaml from "yaml";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVault, isValidPublicKey } from "../../config/vault-aliases";
import { SolanaVault } from "../../../vault";
import { findIdlPath, loadIdl } from "../../utils";

interface BatchOperation {
  operation: "deposit" | "withdraw" | "mint" | "redeem" | "pause" | "unpause";
  vault: string;
  amount?: string;
  receiver?: string;
}

interface BatchFile {
  name?: string;
  description?: string;
  operations: BatchOperation[];
}

export function registerBatchCommand(program: Command): void {
  const batch = program
    .command("batch")
    .description("Execute batch operations from a YAML file");

  batch
    .command("run")
    .description("Run operations from a batch file")
    .argument("<file>", "Path to batch YAML file")
    .option(
      "--continue-on-error",
      "Continue execution even if an operation fails",
    )
    .option("--program-id <pubkey>", "Default program ID for vaults")
    .option("--asset-mint <pubkey>", "Default asset mint")
    .action(async (file, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, connection, provider, wallet, options } = ctx;

      if (!fs.existsSync(file)) {
        output.error(`Batch file not found: ${file}`);
        process.exit(1);
      }

      let batchConfig: BatchFile;
      try {
        const content = fs.readFileSync(file, "utf-8");
        batchConfig = yaml.parse(content);
      } catch (error) {
        output.error(
          `Failed to parse batch file: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }

      if (!batchConfig.operations || batchConfig.operations.length === 0) {
        output.error("No operations found in batch file");
        process.exit(1);
      }

      output.info(`Batch: ${batchConfig.name || "Unnamed"}`);
      if (batchConfig.description) {
        output.info(`Description: ${batchConfig.description}`);
      }
      output.info(`Operations: ${batchConfig.operations.length}`);
      output.info("");

      const results: {
        index: number;
        operation: string;
        vault: string;
        status: string;
        details?: string;
      }[] = [];

      for (let i = 0; i < batchConfig.operations.length; i++) {
        const op = batchConfig.operations[i];
        output.info(
          `[${i + 1}/${batchConfig.operations.length}] ${op.operation} on ${op.vault}...`,
        );

        try {
          let programId: PublicKey;
          let assetMint: PublicKey;
          let vaultId = new BN(1);

          if (isValidPublicKey(op.vault)) {
            if (!opts.programId || !opts.assetMint) {
              throw new Error(
                "--program-id and --asset-mint required for raw vault addresses",
              );
            }
            programId = new PublicKey(opts.programId);
            assetMint = new PublicKey(opts.assetMint);
          } else {
            const resolved = resolveVault(op.vault, config);
            programId = resolved.programId;
            if (!resolved.assetMint) {
              throw new Error(
                `Vault "${op.vault}" missing assetMint in config`,
              );
            }
            assetMint = resolved.assetMint;
            vaultId = resolved.vaultId || vaultId;
          }

          const idlPath = findIdlPath();
          if (!idlPath) throw new Error("IDL not found");

          const idl = loadIdl(idlPath);
          const prog = new Program(idl as any, provider);
          const vault = await SolanaVault.load(prog, assetMint, vaultId);

          let signature: string | undefined;
          const amount = op.amount ? new BN(op.amount) : undefined;
          const receiver = op.receiver
            ? new PublicKey(op.receiver)
            : wallet.publicKey;

          if (options.dryRun) {
            results.push({
              index: i + 1,
              operation: op.operation,
              vault: op.vault,
              status: "dry-run",
              details: `Would execute ${op.operation}${amount ? ` with amount ${amount.toString()}` : ""}`,
            });
            continue;
          }

          switch (op.operation) {
            case "deposit":
              if (!amount) throw new Error("Amount required for deposit");
              signature = await vault.deposit(wallet.publicKey, {
                assets: amount,
                minSharesOut: new BN(0),
              });
              break;
            case "withdraw":
              if (!amount) throw new Error("Amount required for withdraw");
              signature = await vault.withdraw(wallet.publicKey, {
                assets: amount,
                maxSharesIn: new BN("18446744073709551615"),
              });
              break;
            case "mint":
              if (!amount) throw new Error("Amount required for mint");
              signature = await vault.mint(wallet.publicKey, {
                shares: amount,
                maxAssetsIn: new BN("18446744073709551615"),
              });
              break;
            case "redeem":
              if (!amount) throw new Error("Amount required for redeem");
              signature = await vault.redeem(wallet.publicKey, {
                shares: amount,
                minAssetsOut: new BN(0),
              });
              break;
            case "pause":
              signature = await vault.pause(wallet.publicKey);
              break;
            case "unpause":
              signature = await vault.unpause(wallet.publicKey);
              break;
            default:
              throw new Error(`Unknown operation: ${op.operation}`);
          }

          results.push({
            index: i + 1,
            operation: op.operation,
            vault: op.vault,
            status: "success",
            details: signature
              ? `Sig: ${signature.substring(0, 20)}...`
              : undefined,
          });
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          results.push({
            index: i + 1,
            operation: op.operation,
            vault: op.vault,
            status: "error",
            details: errorMsg,
          });

          if (!opts.continueOnError) {
            output.error(`Operation failed, stopping batch execution`);
            break;
          }
        }
      }

      output.info("");
      if (globalOpts.output === "json") {
        output.json({
          batch: batchConfig.name || file,
          totalOperations: batchConfig.operations.length,
          completed: results.filter((r) => r.status === "success").length,
          failed: results.filter((r) => r.status === "error").length,
          results,
        });
        return;
      }

      output.info("Batch results:");
      output.table(
        ["#", "Operation", "Vault", "Status", "Details"],
        results.map((r) => [
          r.index.toString(),
          r.operation,
          r.vault,
          r.status,
          r.details || "-",
        ]),
      );

      const successCount = results.filter((r) => r.status === "success").length;
      const errorCount = results.filter((r) => r.status === "error").length;
      const dryRunCount = results.filter((r) => r.status === "dry-run").length;

      output.info("");
      if (dryRunCount > 0) {
        output.info(`Dry run: ${dryRunCount} operations would be executed`);
      } else if (errorCount === 0) {
        output.success(`All ${successCount} operations completed successfully`);
      } else {
        output.warn(`Completed: ${successCount}, Failed: ${errorCount}`);
      }
    });

  batch
    .command("validate")
    .description("Validate a batch file without executing")
    .argument("<file>", "Path to batch YAML file")
    .action(async (file) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config } = ctx;

      if (!fs.existsSync(file)) {
        output.error(`Batch file not found: ${file}`);
        process.exit(1);
      }

      let batchConfig: BatchFile;
      try {
        const content = fs.readFileSync(file, "utf-8");
        batchConfig = yaml.parse(content);
      } catch (error) {
        output.error(
          `Failed to parse batch file: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }

      const issues: string[] = [];

      if (!batchConfig.operations) {
        issues.push("Missing 'operations' field");
      } else if (!Array.isArray(batchConfig.operations)) {
        issues.push("'operations' must be an array");
      } else {
        const validOps = [
          "deposit",
          "withdraw",
          "mint",
          "redeem",
          "pause",
          "unpause",
        ];
        batchConfig.operations.forEach((op, i) => {
          if (!op.operation) {
            issues.push(`Operation ${i + 1}: missing 'operation' field`);
          } else if (!validOps.includes(op.operation)) {
            issues.push(
              `Operation ${i + 1}: invalid operation '${op.operation}'`,
            );
          }
          if (!op.vault) {
            issues.push(`Operation ${i + 1}: missing 'vault' field`);
          }
          if (
            ["deposit", "withdraw", "mint", "redeem"].includes(op.operation) &&
            !op.amount
          ) {
            issues.push(
              `Operation ${i + 1}: '${op.operation}' requires 'amount'`,
            );
          }
        });
      }

      if (globalOpts.output === "json") {
        output.json({
          file,
          valid: issues.length === 0,
          operationCount: batchConfig.operations?.length || 0,
          issues,
        });
        return;
      }

      if (issues.length === 0) {
        output.success(`Batch file is valid`);
        output.info(`Name: ${batchConfig.name || "Unnamed"}`);
        output.info(`Operations: ${batchConfig.operations.length}`);
      } else {
        output.error(`Batch file has ${issues.length} issue(s):`);
        issues.forEach((issue) => output.info(`  • ${issue}`));
      }
    });

  batch
    .command("template")
    .description("Generate a template batch file")
    .argument("<output>", "Output file path")
    .action(async (outputPath) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, false, false);
      const { output } = ctx;

      const template: BatchFile = {
        name: "Example Batch Operations",
        description: "Template batch file for vault operations",
        operations: [
          {
            operation: "deposit",
            vault: "my-vault",
            amount: "1000000",
          },
          {
            operation: "withdraw",
            vault: "my-vault",
            amount: "500000",
            receiver: "ReceiverPublicKeyHere",
          },
          {
            operation: "pause",
            vault: "my-vault",
          },
        ],
      };

      const content = yaml.stringify(template);
      fs.writeFileSync(outputPath, content);

      output.success(`Template written to ${outputPath}`);
    });
}
