/** Dashboard Command - Live terminal UI for vault monitoring */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import * as blessed from "blessed";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolanaVault } from "../../../vault";
import { formatAddress } from "../../output";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";

interface DashboardState {
  totalAssets: string;
  totalShares: string;
  sharePrice: string;
  paused: boolean;
  authority: string;
  lastUpdate: Date;
  error?: string;
}

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Live terminal dashboard for vault monitoring")
    .argument("<vault>", "Vault address or alias")
    .option("--refresh <seconds>", "Refresh interval in seconds", "5")
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

      const refreshInterval = parseInt(opts.refresh) * 1000;

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await SolanaVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );

        await runDashboard(vault, vaultArg, resolved.variant, refreshInterval);
      } catch (error) {
        output.error(
          `Dashboard failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}

async function runDashboard(
  vault: SolanaVault,
  vaultName: string,
  variant: string,
  refreshInterval: number,
): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: `SVS Dashboard - ${vaultName}`,
  });

  const headerBox = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    content: "",
    tags: true,
    style: {
      fg: "white",
      bg: "blue",
    },
  });

  const statsBox = blessed.box({
    top: 3,
    left: 0,
    width: "50%",
    height: "50%-3",
    label: " Vault Stats ",
    border: { type: "line" },
    content: "Loading...",
    tags: true,
    style: {
      border: { fg: "cyan" },
    },
  });

  const detailsBox = blessed.box({
    top: 3,
    left: "50%",
    width: "50%",
    height: "50%-3",
    label: " Details ",
    border: { type: "line" },
    content: "Loading...",
    tags: true,
    style: {
      border: { fg: "cyan" },
    },
  });

  const logBox = blessed.box({
    top: "50%",
    left: 0,
    width: "100%",
    height: "50%-1",
    label: " Activity Log ",
    border: { type: "line" },
    content: "",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      border: { fg: "green" },
    },
  });

  const footerBox = blessed.box({
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    content:
      " {bold}[q]{/bold} Quit  {bold}[r]{/bold} Refresh  {bold}[↑↓]{/bold} Scroll ",
    tags: true,
    style: {
      fg: "black",
      bg: "white",
    },
  });

  screen.append(headerBox);
  screen.append(statsBox);
  screen.append(detailsBox);
  screen.append(logBox);
  screen.append(footerBox);

  const logs: string[] = [];
  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    logs.push(`{gray-fg}${timestamp}{/gray-fg} ${message}`);
    if (logs.length > 100) logs.shift();
    logBox.setContent(logs.join("\n"));
    logBox.setScrollPerc(100);
  };

  const updateDashboard = async () => {
    try {
      const state = await vault.getState();
      const totalAssets = await vault.totalAssets();
      const totalShares = await vault.totalShares();

      let sharePrice = "1.000000";
      if (!totalShares.isZero()) {
        const priceRaw = totalAssets.muln(1000000).div(totalShares);
        sharePrice = (priceRaw.toNumber() / 1000000).toFixed(6);
      }

      headerBox.setContent(
        `  {bold}${vaultName.toUpperCase()}{/bold}  •  ${variant.toUpperCase()}  •  ${state.paused ? "{red-fg}PAUSED{/red-fg}" : "{green-fg}ACTIVE{/green-fg}"}  •  Last update: ${new Date().toLocaleTimeString()}`,
      );

      statsBox.setContent(
        `\n  {bold}Total Assets:{/bold}  ${totalAssets.toString()}\n` +
          `  {bold}Total Shares:{/bold}  ${totalShares.toString()}\n` +
          `  {bold}Share Price:{/bold}   ${sharePrice}\n\n` +
          `  {bold}Status:{/bold}        ${state.paused ? "{red-fg}⏸ Paused{/red-fg}" : "{green-fg}✓ Active{/green-fg}"}`,
      );

      detailsBox.setContent(
        `\n  {bold}Authority:{/bold}\n  ${formatAddress(state.authority.toBase58(), false)}\n\n` +
          `  {bold}Asset Mint:{/bold}\n  ${formatAddress(state.assetMint.toBase58(), false)}\n\n` +
          `  {bold}Shares Mint:{/bold}\n  ${formatAddress(state.sharesMint.toBase58(), false)}\n\n` +
          `  {bold}Decimals Offset:{/bold} ${state.decimalsOffset}`,
      );

      addLog(
        `{green-fg}✓{/green-fg} Refreshed - Assets: ${totalAssets.toString()}, Shares: ${totalShares.toString()}`,
      );

      screen.render();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addLog(`{red-fg}✗{/red-fg} Error: ${msg}`);
      screen.render();
    }
  };

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.key(["r"], () => {
    addLog("{yellow-fg}↻{/yellow-fg} Manual refresh...");
    updateDashboard();
  });

  screen.key(["up"], () => {
    logBox.scroll(-1);
    screen.render();
  });

  screen.key(["down"], () => {
    logBox.scroll(1);
    screen.render();
  });

  addLog("{blue-fg}ℹ{/blue-fg} Dashboard started");
  addLog(`{blue-fg}ℹ{/blue-fg} Auto-refresh every ${refreshInterval / 1000}s`);

  await updateDashboard();

  const interval = setInterval(updateDashboard, refreshInterval);

  screen.on("destroy", () => {
    clearInterval(interval);
  });

  screen.render();
}
