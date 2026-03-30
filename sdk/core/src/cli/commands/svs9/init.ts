/** svs9 init — Initialize a new SVS-9 Allocator Vault */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { findIdlPath, loadIdl, formatNumber } from "../../utils";
import {
  getAllocatorVaultAddress,
  getIdleVaultAddress,
  AllocatorVaultClient,
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
    .option("--decimals-offset <number>", "Decimals offset for inflation protection (0-9)", "0")
    .option("--shares-mint <keypair-path>", "Path to shares mint keypair (generated if omitted)")
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
        const vaultId = new BN(opts.vaultId);
        const idleBufferBps = parseInt(opts.idleBuffer);
        const assetMint = new PublicKey(opts.assetMint);
        const curator = new PublicKey(opts.curator);
        const decimalsOffset = parseInt(opts.decimalsOffset);

        // Derive addresses
        const assetTokenProgram = await getTokenProgramForMint(
          provider.connection,
          assetMint,
        );
        const [allocatorVault] = getAllocatorVaultAddress(
          new PublicKey((loadIdl(idlPath) as any).address),
          assetMint,
          vaultId,
        );
        const idleVault = getIdleVaultAddress(allocatorVault, assetMint, assetTokenProgram);

        // Shares mint keypair
        const sharesMintKeypair = opts.sharesMint
          ? Keypair.fromSecretKey(
              Uint8Array.from(
                JSON.parse(require("fs").readFileSync(opts.sharesMint, "utf-8")),
              ),
            )
          : Keypair.generate();

        output.info("═══ SVS-9 Allocator Vault Initialization ═══");
        output.info(`  Vault ID:        ${vaultId.toString()}`);
        output.info(`  Idle Buffer:     ${idleBufferBps} bps (${(idleBufferBps / 100).toFixed(1)}%)`);
        output.info(`  Asset Mint:      ${assetMint.toBase58()}`);
        output.info(`  Curator:         ${curator.toBase58()}`);
        output.info(`  Decimals Offset: ${decimalsOffset}`);
        output.info(`  Allocator PDA:   ${allocatorVault.toBase58()}`);
        output.info(`  Idle Vault ATA:  ${idleVault.toBase58()}`);
        output.info(`  Shares Mint:     ${sharesMintKeypair.publicKey.toBase58()}`);

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

        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const methodsNs = prog.methods as any;

        const signature = await methodsNs
          .initialize(vaultId, idleBufferBps, decimalsOffset)
          .accountsPartial({
            authority: wallet.publicKey,
            curator,
            allocatorVault,
            assetMint,
            sharesMint: sharesMintKeypair.publicKey,
            idleVault,
            tokenProgram: assetTokenProgram,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([sharesMintKeypair])
          .rpc();

        spinner.succeed("SVS-9 Allocator Vault initialized!");
        output.success(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            allocatorVault: allocatorVault.toBase58(),
            sharesMint: sharesMintKeypair.publicKey.toBase58(),
            idleVault: idleVault.toBase58(),
            vaultId: vaultId.toString(),
            idleBufferBps,
            decimalsOffset,
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
