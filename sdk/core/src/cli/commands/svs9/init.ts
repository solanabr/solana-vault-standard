/** svs9 init — Initialize a new SVS-9 Allocator Vault */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { findIdlPath, loadIdl } from "../../utils";
import {
  getAllocatorVaultAddress,
  getIdleVaultAddress,
} from "../../../svs9";
import { getTokenProgramForMint } from "../../../vault";

export function registerSvs9InitCommand(parent: Command): void {
  parent
    .command("init")
    .description("Initialize a new SVS-9 allocator vault")
    .requiredOption("--vault-id <number>", "Unique vault ID (u64)")
    .requiredOption("--idle-buffer <bps>", "Idle buffer in basis points (e.g. 1000 = 10%)")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .requiredOption("--curator <pubkey>", "Curator public key")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const idlPath = findIdlPath("svs-9");
      if (!idlPath) {
        output.error("SVS-9 IDL not found. Run `anchor build -p svs_9` first.");
        process.exit(1);
      }

      try {
        const vaultId = new BN(opts.vaultId);
        const idleBufferBps = parseInt(opts.idleBuffer);
        const assetMint = new PublicKey(opts.assetMint);
        const curator = new PublicKey(opts.curator);
        const idl = loadIdl(idlPath) as { address: string };
        const programId = new PublicKey(idl.address);

        // Derive addresses
        const assetTokenProgram = await getTokenProgramForMint(
          provider.connection,
          assetMint,
        );
        const [allocatorVault] = getAllocatorVaultAddress(
          programId,
          assetMint,
          vaultId,
        );
        const [sharesMint] = PublicKey.findProgramAddressSync(
          [Buffer.from("shares_mint"), allocatorVault.toBuffer()],
          programId,
        );
        const idleVault = getIdleVaultAddress(allocatorVault, assetMint, assetTokenProgram);

        output.info("═══ SVS-9 Allocator Vault Initialization ═══");
        output.info(`  Vault ID:        ${vaultId.toString()}`);
        output.info(`  Idle Buffer:     ${idleBufferBps} bps (${(idleBufferBps / 100).toFixed(1)}%)`);
        output.info(`  Asset Mint:      ${assetMint.toBase58()}`);
        output.info(`  Curator:         ${curator.toBase58()}`);
        output.info(`  Allocator PDA:   ${allocatorVault.toBase58()}`);
        output.info(`  Idle Vault ATA:  ${idleVault.toBase58()}`);
        output.info(`  Shares Mint PDA: ${sharesMint.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed with initialization?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Initializing SVS-9 vault...");
        spinner.start();

        const prog = new Program(idl as any, provider);
        const methodsNs = prog.methods as any;

        const signature = await methodsNs
          .initialize(vaultId, idleBufferBps)
          .accountsPartial({
            authority: wallet.publicKey,
            curator,
            allocatorVault,
            assetMint,
            sharesMint,
            idleVault,
            tokenProgram: assetTokenProgram,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        spinner.succeed("SVS-9 Allocator Vault initialized!");
        output.success(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            allocatorVault: allocatorVault.toBase58(),
            sharesMint: sharesMint.toBase58(),
            idleVault: idleVault.toBase58(),
            vaultId: vaultId.toString(),
            idleBufferBps,
          });
        }
      } catch (error) {
        output.error(
          `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
