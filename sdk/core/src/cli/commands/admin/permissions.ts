/** Permissions Command - Display vault access control and role assignments */

import { Command } from "commander";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { isAllocatorVariant, loadVaultClient, resolveVaultArg } from "../../utils";
import { SvsVariant } from "../../types";

export function registerPermissionsCommand(program: Command): void {
  program
    .command("permissions")
    .description("Show who can do what in a vault")
    .argument("<vault>", "Vault address or alias")
    .option("--variant <variant>", "SVS variant (for raw vault addresses)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      try {
        const vault = await loadVaultClient(provider, resolved);
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
            ...(isAllocatorVariant(variant) && {
              curator: (state as any).curator.toBase58(),
            }),
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

        if (isAllocatorVariant(variant)) {
          output.info("");
          output.info("CURATOR");
          output.info(`  Address: ${(state as any).curator.toBase58()}`);
          output.info("  Can:");
          output.info("    • Allocate idle assets to child vaults");
          output.info("    • Deallocate principal back to idle liquidity");
          output.info("    • Harvest yield from child vaults");
          output.info("    • Rebalance idle buffer across child vaults");
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

  if (variant === "svs-9") {
    base.push("Set curator for allocator operations");
    base.push("Add, remove, and reweight child vaults");
  }

  return base;
}
