import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { TranchedVault } from "../../../tranched-vault";
import { findIdlPath, loadIdl, formatNumber } from "../../utils";

export function registerTranchedInfoCommand(parent: Command): void {
  parent
    .command("info")
    .description("Display tranched vault state and tranche details")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, provider } = ctx;

      const idlPath = findIdlPath("svs-12");
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const assetMint = new PublicKey(opts.assetMint);
        const vault = await TranchedVault.load(
          prog,
          assetMint,
          new BN(opts.vaultId),
        );
        const state = await vault.getState();

        const waterfallLabel =
          "sequential" in state.waterfallMode
            ? "Sequential"
            : "ProRata Yield / Sequential Loss";

        output.info("=== Tranched Vault ===");
        output.info(`Address:    ${vault.vault.toBase58()}`);
        output.info(`Authority:  ${state.authority.toBase58()}`);
        output.info(`Manager:    ${state.manager.toBase58()}`);
        output.info(`Asset Mint: ${state.assetMint.toBase58()}`);
        output.info(`Total Assets: ${formatNumber(state.totalAssets)}`);
        output.info(`Tranches:   ${state.numTranches}`);
        output.info(`Waterfall:  ${waterfallLabel}`);
        output.info(`Paused:     ${state.paused}`);
        output.info(`Wiped:      ${state.wiped}`);
        output.info("");

        for (let i = 0; i < state.numTranches; i++) {
          const t = await vault.getTrancheState(i);
          output.info(`--- Tranche ${i} (priority=${t.priority}) ---`);
          output.info(`  Shares Mint:   ${t.sharesMint.toBase58()}`);
          output.info(`  Total Shares:  ${formatNumber(t.totalShares)}`);
          output.info(
            `  Allocated:     ${formatNumber(t.totalAssetsAllocated)}`,
          );
          output.info(`  Target Yield:  ${t.targetYieldBps}bps`);
          output.info(`  Cap:           ${t.capBps}bps`);
          output.info(`  Subordination: ${t.subordinationBps}bps`);
        }

        if (globalOpts.output === "json") {
          const tranches = [];
          for (let i = 0; i < state.numTranches; i++) {
            const t = await vault.getTrancheState(i);
            tranches.push({
              index: t.index,
              priority: t.priority,
              sharesMint: t.sharesMint.toBase58(),
              totalShares: t.totalShares.toString(),
              totalAssetsAllocated: t.totalAssetsAllocated.toString(),
              targetYieldBps: t.targetYieldBps,
              capBps: t.capBps,
              subordinationBps: t.subordinationBps,
            });
          }
          output.json({
            vault: vault.vault.toBase58(),
            authority: state.authority.toBase58(),
            manager: state.manager.toBase58(),
            assetMint: state.assetMint.toBase58(),
            totalAssets: state.totalAssets.toString(),
            numTranches: state.numTranches,
            waterfallMode: waterfallLabel,
            paused: state.paused,
            wiped: state.wiped,
            tranches,
          });
        }
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
