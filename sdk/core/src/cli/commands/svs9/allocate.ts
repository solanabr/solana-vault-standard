/** svs9 allocate — Curator sends idle funds to a child vault */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { findIdlPath, loadIdl, formatNumber } from "../../utils";
import {
  getAllocatorVaultAddress,
  getChildAllocationAddress,
  getAllocatorChildSharesAddress,
  getIdleVaultAddress,
} from "../../../svs9";
import { getTokenProgramForMint } from "../../../vault";

export function registerSvs9AllocateCommand(parent: Command): void {
  parent
    .command("allocate")
    .description("Allocate idle funds to a child vault (curator-only)")
    .requiredOption("--vault-id <number>", "Allocator vault ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint of the allocator vault")
    .requiredOption("--child-vault <pubkey>", "Child vault to allocate into")
    .requiredOption("--child-program <pubkey>", "Child vault's SVS program ID")
    .requiredOption("--child-asset-mint <pubkey>", "Child vault's asset mint")
    .requiredOption("--child-asset-vault <pubkey>", "Child vault's asset token account")
    .requiredOption("--child-shares-mint <pubkey>", "Child vault's shares mint")
    .requiredOption("-a, --amount <number>", "Amount of assets to allocate")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const idlPath = findIdlPath("svs-9" as any);
      if (!idlPath) {
        output.error("SVS-9 IDL not found. Run `anchor build -p svs_9` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const programId = new PublicKey((idl as any).address);
        const vaultId = new BN(opts.vaultId);
        const assetMint = new PublicKey(opts.assetMint);
        const childVault = new PublicKey(opts.childVault);
        const childProgram = new PublicKey(opts.childProgram);
        const childAssetMint = new PublicKey(opts.childAssetMint);
        const childAssetVault = new PublicKey(opts.childAssetVault);
        const childSharesMint = new PublicKey(opts.childSharesMint);
        const amount = new BN(opts.amount);

        const assetTokenProgram = await getTokenProgramForMint(
          provider.connection,
          assetMint,
        );

        const [allocatorVault] = getAllocatorVaultAddress(programId, assetMint, vaultId);
        const [childAllocation] = getChildAllocationAddress(programId, allocatorVault, childVault);
        const idleVault = getIdleVaultAddress(allocatorVault, assetMint, assetTokenProgram);
        const allocatorChildSharesAccount = getAllocatorChildSharesAddress(
          allocatorVault,
          childSharesMint,
        );

        output.info("═══ SVS-9 Allocate to Child Vault ═══");
        output.info(`  Allocator:       ${allocatorVault.toBase58()}`);
        output.info(`  Child Vault:     ${childVault.toBase58()}`);
        output.info(`  Amount:          ${formatNumber(amount)} lamports`);
        output.info(`  Child Program:   ${childProgram.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with allocation?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Allocating to child vault...");
        spinner.start();

        const prog = new Program(idl as any, provider);
        const methodsNs = prog.methods as any;

        const signature = await methodsNs
          .allocate(amount)
          .accountsPartial({
            curator: wallet.publicKey,
            allocatorVault,
            childAllocation,
            idleVault,
            childVault,
            childProgram,
            childAssetMint,
            childAssetVault,
            childSharesMint,
            allocatorChildSharesAccount,
            tokenProgram: assetTokenProgram,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();

        spinner.succeed("Allocation complete!");
        output.success(`Allocated ${formatNumber(amount)} assets to child vault`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            allocatorVault: allocatorVault.toBase58(),
            childVault: childVault.toBase58(),
            amount: amount.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Allocation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
