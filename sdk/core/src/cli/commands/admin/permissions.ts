/** Permissions Command - Display vault access control and role assignments */

import { Command } from "commander";
import { Program } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolanaVault } from "../../../vault";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";
import { SvsVariant } from "../../types";

export function registerPermissionsCommand(program: Command): void {
  program
    .command("permissions")
    .description("Show who can do what in a vault")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

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
        const state = await vault.getState();

        const totalAssets = await vault.totalAssets();
        const totalShares = await vault.totalShares();
        const variant = resolved.variant;

        if (globalOpts.output === "json") {
          output.json({
            vault: vaultArg,
            variant,
            authority: {
              address: state.authority.toBase58(),
              capabilities: getAuthorityCapabilities(variant),
            },
            accessMode: "OPEN",
            paused: state.paused,
            totalAssets: totalAssets.toString(),
            totalShares: totalShares.toString(),
          });
          return;
        }

        output.info(`Permissions for ${vaultArg}`);
        output.info(`Variant: ${variant.toUpperCase()}`);
        output.info("");
        output.info("AUTHORITY");
        output.info(`  Address: ${state.authority.toBase58()}`);
        output.info("  Can:");
        for (const cap of getAuthorityCapabilities(variant)) {
          output.info(`    • ${cap}`);
        }
        output.info("");
        output.info("ACCESS MODE");
        output.info("  Mode: OPEN (anyone can deposit/withdraw)");
        output.info("  Status: " + (state.paused ? "⏸ PAUSED" : "✓ ACTIVE"));
        output.info("");
        output.info("VAULT STATS");
        output.table(
          ["Metric", "Value"],
          [
            ["Total Assets", totalAssets.toString()],
            ["Total Shares", totalShares.toString()],
            ["Decimals Offset", state.decimalsOffset.toString()],
          ],
        );

        if (variant === "svs-3" || variant === "svs-4") {
          output.info("");
          output.info("CONFIDENTIAL TRANSFERS");
          output.info("  This vault supports confidential transfers.");
        }
      } catch (error) {
        output.error(
          `Failed to load permissions: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}

function getAuthorityCapabilities(variant: SvsVariant): string[] {
  const base = [
    "Pause vault (emergency stop)",
    "Unpause vault (resume operations)",
    "Transfer authority to new address",
  ];

  if (variant === "svs-2" || variant === "svs-4") {
    base.push("Sync stored balance with actual balance");
  }

  return base;
}
