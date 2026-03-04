/** History Command - Show recent transaction history for a vault */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolanaVault } from "../../../vault";
import { formatAddress, formatTimestamp } from "../../output";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

interface ParsedTransaction {
  signature: string;
  blockTime: number | null;
  slot: number;
  operation: string;
  status: string;
  fee: number;
}

export function registerHistoryCommand(program: Command): void {
  program
    .command("history")
    .description("Show transaction history for a vault")
    .argument("<vault>", "Vault address or alias")
    .option("--limit <number>", "Maximum number of transactions", "20")
    .option("--before <signature>", "Fetch transactions before this signature")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, connection, provider } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

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
        const vaultAddress = vault.vault;

        const spinner = output.spinner("Fetching transaction history...");
        spinner.start();

        const limit = parseInt(opts.limit);
        const signatures = await connection.getSignaturesForAddress(
          vaultAddress,
          {
            limit,
            before: opts.before,
          },
        );

        if (signatures.length === 0) {
          spinner.succeed("No transactions found");
          return;
        }

        const transactions: ParsedTransaction[] = [];

        for (const sigInfo of signatures) {
          let operation = "unknown";

          try {
            const tx = await connection.getParsedTransaction(
              sigInfo.signature,
              {
                maxSupportedTransactionVersion: 0,
              },
            );

            if (tx?.meta?.logMessages) {
              for (const log of tx.meta.logMessages) {
                if (log.includes("Instruction: Deposit")) {
                  operation = "deposit";
                  break;
                } else if (log.includes("Instruction: Withdraw")) {
                  operation = "withdraw";
                  break;
                } else if (log.includes("Instruction: Mint")) {
                  operation = "mint";
                  break;
                } else if (log.includes("Instruction: Redeem")) {
                  operation = "redeem";
                  break;
                } else if (log.includes("Instruction: Pause")) {
                  operation = "pause";
                  break;
                } else if (log.includes("Instruction: Unpause")) {
                  operation = "unpause";
                  break;
                } else if (log.includes("Instruction: Initialize")) {
                  operation = "initialize";
                  break;
                } else if (log.includes("Instruction: Sync")) {
                  operation = "sync";
                  break;
                } else if (log.includes("Instruction: TransferAuthority")) {
                  operation = "transfer-authority";
                  break;
                }
              }
            }
          } catch {
            // Unable to parse, keep as unknown
          }

          transactions.push({
            signature: sigInfo.signature,
            blockTime: sigInfo.blockTime ?? null,
            slot: sigInfo.slot,
            operation,
            status: sigInfo.err ? "failed" : "success",
            fee: 0,
          });
        }

        spinner.succeed(`Found ${transactions.length} transactions`);

        if (globalOpts.output === "json") {
          output.json({
            vault: vaultArg,
            vaultAddress: vaultAddress.toBase58(),
            transactionCount: transactions.length,
            transactions: transactions.map((tx) => ({
              signature: tx.signature,
              blockTime: tx.blockTime,
              slot: tx.slot,
              operation: tx.operation,
              status: tx.status,
            })),
          });
          return;
        }

        output.info(`\nTransaction history for ${vaultArg}`);
        output.info(
          `Vault address: ${formatAddress(vaultAddress.toBase58(), false)}\n`,
        );

        output.table(
          ["Time", "Operation", "Status", "Signature"],
          transactions.map((tx) => [
            tx.blockTime ? formatTimestamp(tx.blockTime) : "-",
            tx.operation,
            tx.status === "success" ? "✓" : "✗",
            formatAddress(tx.signature, false),
          ]),
        );

        if (transactions.length === limit) {
          output.info("");
          output.info(
            `Showing ${limit} transactions. Use --before ${transactions[transactions.length - 1].signature.substring(0, 20)}... to see more.`,
          );
        }
      } catch (error) {
        output.error(
          `Failed to fetch history: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
