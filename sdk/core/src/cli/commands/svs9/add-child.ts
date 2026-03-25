/** svs9 add-child — Add a child vault to the allocator */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { findIdlPath, loadIdl } from "../../utils";
import {
  getAllocatorChildSharesAddress,
  getAllocatorVaultAddress,
  getChildAllocationAddress,
} from "../../../svs9";

function inferChildSharesMint(data: Buffer): PublicKey {
  if (data.length === 197 || data.length === 201 || data.length === 211) {
    return new PublicKey(data.subarray(72, 104));
  }

  if (data.length === 246 || data.length === 254) {
    return new PublicKey(data.subarray(72, 104));
  }

  throw new Error(`Unsupported child vault layout: ${data.length} bytes`);
}

export function registerSvs9AddChildCommand(parent: Command): void {
  parent
    .command("add-child")
    .description("Add a child vault to the SVS-9 allocator")
    .requiredOption("--vault-id <number>", "Allocator vault ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint of the allocator vault")
    .requiredOption("--child-vault <pubkey>", "Child vault public key")
    .requiredOption("--child-program <pubkey>", "Child vault's program ID")
    .requiredOption("--max-weight <bps>", "Maximum weight in basis points (0-10000)")
    .option(
      "--child-decimals-offset <number>",
      "Inflation-protection decimals offset used by the child vault",
      "0",
    )
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet, connection } = ctx;

      const idlPath = findIdlPath("svs-9");
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
        const maxWeightBps = parseInt(opts.maxWeight);
        const childDecimalsOffset = parseInt(opts.childDecimalsOffset);

        if (maxWeightBps < 0 || maxWeightBps > 10000) {
          output.error("Max weight must be between 0 and 10000 bps.");
          process.exit(1);
        }

        if (childDecimalsOffset < 0 || childDecimalsOffset > 255) {
          output.error("Child decimals offset must be between 0 and 255.");
          process.exit(1);
        }

        const [allocatorVault] = getAllocatorVaultAddress(programId, assetMint, vaultId);
        const [childAllocation] = getChildAllocationAddress(programId, allocatorVault, childVault);
        const childVaultInfo = await connection.getAccountInfo(childVault);

        if (!childVaultInfo) {
          output.error(`Child vault account not found: ${childVault.toBase58()}`);
          process.exit(1);
        }

        const childSharesMint = inferChildSharesMint(childVaultInfo.data);
        const allocatorChildSharesAccount = getAllocatorChildSharesAddress(
          allocatorVault,
          childSharesMint,
        );

        output.info("═══ SVS-9 Add Child Vault ═══");
        output.info(`  Allocator:       ${allocatorVault.toBase58()}`);
        output.info(`  Child Vault:     ${childVault.toBase58()}`);
        output.info(`  Child Program:   ${childProgram.toBase58()}`);
        output.info(`  Child Shares:    ${childSharesMint.toBase58()}`);
        output.info(`  Allocator ATA:   ${allocatorChildSharesAccount.toBase58()}`);
        output.info(`  Max Weight:      ${maxWeightBps} bps (${(maxWeightBps / 100).toFixed(1)}%)`);
        output.info(`  Decimals Offset: ${childDecimalsOffset}`);
        output.info(`  Child PDA:       ${childAllocation.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with adding child vault?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Adding child vault...");
        spinner.start();

        const prog = new Program(idl as any, provider);
        const methodsNs = prog.methods as any;

        const signature = await methodsNs
          .addChild(maxWeightBps, childDecimalsOffset)
          .accountsPartial({
            authority: wallet.publicKey,
            allocatorVault,
            childAllocation,
            childVault,
            childProgram,
            childSharesMint,
            allocatorChildSharesAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        spinner.succeed("Child vault added!");
        output.success(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            allocatorVault: allocatorVault.toBase58(),
            childVault: childVault.toBase58(),
            childAllocation: childAllocation.toBase58(),
            childSharesMint: childSharesMint.toBase58(),
            allocatorChildSharesAccount: allocatorChildSharesAccount.toBase58(),
            maxWeightBps,
            childDecimalsOffset,
          });
        }
      } catch (error) {
        output.error(
          `Add child failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
