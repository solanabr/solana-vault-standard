/** svs9 status — Display allocator vault state, balances, and children */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { findIdlPath, loadIdl, formatNumber } from "../../utils";
import { formatAddress } from "../../output";
import {
  getAllocatorVaultAddress,
  getIdleVaultAddress,
  getChildAllocationAddress,
  AllocatorVaultState,
} from "../../../svs9";
import { getTokenProgramForMint } from "../../../vault";

export function registerSvs9StatusCommand(parent: Command): void {
  parent
    .command("status")
    .description("Display SVS-9 allocator vault status and children")
    .requiredOption("--vault-id <number>", "Allocator vault ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint of the allocator vault")
    .option("--children <pubkeys...>", "Child vault public keys to inspect")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, provider, connection } = ctx;

      const idlPath = findIdlPath("svs-9" as any);
      if (!idlPath) {
        output.error("SVS-9 IDL not found. Run `anchor build -p svs_9` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const programId = new PublicKey((idl as any).address);
        const prog = new Program(idl as any, provider);
        const vaultId = new BN(opts.vaultId);
        const assetMint = new PublicKey(opts.assetMint);

        const assetTokenProgram = await getTokenProgramForMint(
          connection,
          assetMint,
        );

        const [allocatorVault] = getAllocatorVaultAddress(programId, assetMint, vaultId);
        const idleVault = getIdleVaultAddress(allocatorVault, assetMint, assetTokenProgram);

        // Fetch vault state
        const accountNs = prog.account as Record<
          string,
          { fetch: (addr: PublicKey) => Promise<unknown> }
        >;
        const state = (await accountNs["allocatorVault"].fetch(
          allocatorVault,
        )) as AllocatorVaultState;

        // Fetch idle balance
        let idleBalance: BN;
        try {
          const idleAccount = await getAccount(connection, idleVault, undefined, assetTokenProgram);
          idleBalance = new BN(idleAccount.amount.toString());
        } catch {
          idleBalance = new BN(0);
        }

        // ─── Header ───
        output.success("═══ SVS-9 Allocator Vault Status ═══");

        if (globalOpts.output === "json") {
          const jsonResult: Record<string, unknown> = {
            allocatorVault: allocatorVault.toBase58(),
            authority: state.authority.toBase58(),
            curator: state.curator.toBase58(),
            assetMint: state.assetMint.toBase58(),
            sharesMint: state.sharesMint.toBase58(),
            idleVault: idleVault.toBase58(),
            idleBalance: idleBalance.toString(),
            idleBufferBps: state.idleBufferBps,
            numChildren: state.numChildren,
            paused: state.paused,
            vaultId: state.vaultId.toString(),
            children: [] as Record<string, unknown>[],
          };

          // Fetch child data if provided
          if (opts.children) {
            for (const childKey of opts.children) {
              const childVault = new PublicKey(childKey);
              try {
                const [childAllocationPda] = getChildAllocationAddress(
                  programId,
                  allocatorVault,
                  childVault,
                );
                const childState = await accountNs["childAllocation"].fetch(childAllocationPda);
                (jsonResult.children as Record<string, unknown>[]).push({
                  childVault: childKey,
                  ...(childState as Record<string, unknown>),
                });
              } catch {
                (jsonResult.children as Record<string, unknown>[]).push({
                  childVault: childKey,
                  error: "Not found or not initialized",
                });
              }
            }
          }

          output.json(jsonResult);
        } else {
          // ─── Table Output ───
          output.table(
            ["Property", "Value"],
            [
              ["Allocator PDA", formatAddress(allocatorVault.toBase58())],
              ["Authority", formatAddress(state.authority.toBase58())],
              ["Curator", formatAddress(state.curator.toBase58())],
              ["Asset Mint", formatAddress(state.assetMint.toBase58())],
              ["Shares Mint", formatAddress(state.sharesMint.toBase58())],
              ["Idle Vault", formatAddress(idleVault.toBase58())],
              ["Idle Balance", formatNumber(idleBalance)],
              ["Idle Buffer", `${state.idleBufferBps} bps (${(state.idleBufferBps / 100).toFixed(1)}%)`],
              ["Children", state.numChildren.toString()],
              ["Paused", state.paused ? "⛔ Yes" : "✅ No"],
              ["Vault ID", state.vaultId.toString()],
            ],
          );

          // ─── Children Details ───
          if (opts.children && opts.children.length > 0) {
            output.info("");
            output.info("─── Child Vaults ───");

            const childRows: string[][] = [];

            for (const childKey of opts.children) {
              const childVault = new PublicKey(childKey);
              try {
                const [childAllocationPda] = getChildAllocationAddress(
                  programId,
                  allocatorVault,
                  childVault,
                );
                const childState = (await accountNs["childAllocation"].fetch(
                  childAllocationPda,
                )) as any;

                childRows.push([
                  formatAddress(childKey),
                  childState.enabled ? "✅" : "⛔",
                  `${childState.maxWeightBps} bps`,
                  `${childState.targetWeightBps} bps`,
                  formatNumber(new BN(childState.depositedAssets.toString())),
                  formatAddress(childState.childProgram.toBase58()),
                ]);
              } catch {
                childRows.push([
                  formatAddress(childKey),
                  "❓",
                  "—",
                  "—",
                  "—",
                  "Not initialized",
                ]);
              }
            }

            output.table(
              ["Child Vault", "Enabled", "Max Weight", "Target Weight", "Deposited", "Program"],
              childRows,
            );
          } else if (state.numChildren > 0) {
            output.info("");
            output.warn(
              `${state.numChildren} child vault(s) connected. Use --children <pubkey...> to inspect them.`,
            );
          }
        }
      } catch (error) {
        output.error(
          `Status check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
