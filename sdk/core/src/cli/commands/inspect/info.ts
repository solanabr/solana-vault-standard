/** Info Command - Display vault state, addresses, and statistics */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVault, isValidPublicKey } from "../../config/vault-aliases";
import { deriveVaultAddresses } from "../../../pda";
import {
  deriveAllocatorAddresses,
  AllocatorVaultClient,
} from "../../../svs9";
import { SolanaVault } from "../../../vault";
import { formatAddress } from "../../output";
import {
  isAllocatorVariant,
  loadProgramForVariant,
} from "../../utils";
import { SvsVariant } from "../../types";

export function registerInfoCommand(program: Command): void {
  program
    .command("info")
    .description("Show vault state and information")
    .argument("[vault]", "Vault address or alias")
    .option("--variant <variant>", "SVS variant (for raw vault addresses)")
    .option(
      "--program-id <pubkey>",
      "Program ID (required if vault not in config)",
    )
    .option(
      "--asset-mint <pubkey>",
      "Asset mint address (required if vault not in config)",
    )
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

      let programId: PublicKey;
      let assetMint: PublicKey | undefined;
      let vaultId: BN;
      let vaultAddress: PublicKey | undefined;
      let variant: SvsVariant = (opts.variant as SvsVariant) || "svs-1";

      if (vaultArg && isValidPublicKey(vaultArg)) {
        vaultAddress = new PublicKey(vaultArg);
        if (!opts.programId) {
          output.error(
            "Program ID required when using raw vault address.\n" +
              "Either add vault to config or provide --program-id",
          );
          process.exit(1);
        }
        programId = new PublicKey(opts.programId);
        assetMint = opts.assetMint ? new PublicKey(opts.assetMint) : undefined;
        vaultId = new BN(opts.vaultId);
        variant = (opts.variant as SvsVariant) || "svs-1";
      } else if (vaultArg) {
        try {
          const resolved = resolveVault(vaultArg, config);
          vaultAddress = resolved.address;
          programId = resolved.programId;
          assetMint = resolved.assetMint;
          vaultId = resolved.vaultId || new BN(opts.vaultId);
          variant = resolved.variant;
        } catch (error) {
          output.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      } else if (opts.programId && opts.assetMint) {
        programId = new PublicKey(opts.programId);
        assetMint = new PublicKey(opts.assetMint);
        vaultId = new BN(opts.vaultId);
        variant = (opts.variant as SvsVariant) || "svs-1";
      } else {
        output.error(
          "Provide a vault address/alias, or --program-id and --asset-mint",
        );
        process.exit(1);
      }

      if (assetMint) {
        if (isAllocatorVariant(variant)) {
          const addresses = deriveAllocatorAddresses(programId!, assetMint, vaultId);
          const [sharesMint, sharesMintBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("shares_mint"), addresses.allocatorVault.toBuffer()],
            programId!,
          );
          vaultAddress = addresses.allocatorVault;

          output.info("Derived Addresses:");
          output.table(
            ["Type", "Address", "Bump"],
            [
              [
                "Allocator Vault PDA",
                addresses.allocatorVault.toBase58(),
                addresses.allocatorBump.toString(),
              ],
              ["Shares Mint", sharesMint.toBase58(), sharesMintBump.toString()],
              ["Idle Vault", addresses.idleVault.toBase58(), "-"],
            ],
          );
        } else {
          const addresses = deriveVaultAddresses(programId!, assetMint, vaultId);
          vaultAddress = addresses.vault;

          output.info("Derived Addresses:");
          output.table(
            ["Type", "Address", "Bump"],
            [
              [
                "Vault PDA",
                addresses.vault.toBase58(),
                addresses.vaultBump.toString(),
              ],
              [
                "Shares Mint",
                addresses.sharesMint.toBase58(),
                addresses.sharesMintBump.toString(),
              ],
            ],
          );
        }
      }

      try {
        if (!assetMint) {
          output.error("Asset mint required to load vault state");
          process.exit(1);
        }

        const prog = loadProgramForVariant(provider, variant, programId);

        if (isAllocatorVariant(variant)) {
          const vault = await AllocatorVaultClient.load(prog, assetMint, vaultId);
          const state = await vault.getState();
          const totalAssets = await vault.totalAssets();
          const totalShares = await vault.totalShares();
          const idleBalance = await vault.getIdleBalance();

          output.success("Vault State");

          if (globalOpts.output === "json") {
            output.json({
              vault: vaultAddress?.toBase58(),
              authority: state.authority.toBase58(),
              curator: state.curator.toBase58(),
              assetMint: state.assetMint.toBase58(),
              sharesMint: state.sharesMint.toBase58(),
              idleVault: state.idleVault.toBase58(),
              idleBalance: idleBalance.toString(),
              totalAssets: totalAssets.toString(),
              totalShares: totalShares.toString(),
              idleBufferBps: state.idleBufferBps,
              numChildren: state.numChildren,
              decimalsOffset: state.decimalsOffset,
              paused: state.paused,
              vaultId: state.vaultId.toString(),
            });
          } else {
            output.table(
              ["Property", "Value"],
              [
                ["Authority", formatAddress(state.authority.toBase58())],
                ["Curator", formatAddress(state.curator.toBase58())],
                ["Asset Mint", formatAddress(state.assetMint.toBase58())],
                ["Shares Mint", formatAddress(state.sharesMint.toBase58())],
                ["Idle Vault", formatAddress(state.idleVault.toBase58())],
                ["Idle Balance", idleBalance.toString()],
                ["Total Assets", totalAssets.toString()],
                ["Total Shares", totalShares.toString()],
                ["Idle Buffer (bps)", state.idleBufferBps.toString()],
                ["Children", state.numChildren.toString()],
                ["Decimals Offset", state.decimalsOffset.toString()],
                ["Paused", state.paused ? "Yes" : "No"],
                ["Vault ID", state.vaultId.toString()],
              ],
            );
          }
        } else {
          const vault = await SolanaVault.load(prog, assetMint, vaultId);
          const state = await vault.getState();
          const totalAssets = await vault.totalAssets();
          const totalShares = await vault.totalShares();

          output.success("Vault State");

          if (globalOpts.output === "json") {
            output.json({
              vault: vaultAddress?.toBase58(),
              authority: state.authority.toBase58(),
              assetMint: state.assetMint.toBase58(),
              sharesMint: state.sharesMint.toBase58(),
              assetVault: state.assetVault.toBase58(),
              totalAssets: totalAssets.toString(),
              totalShares: totalShares.toString(),
              decimalsOffset: state.decimalsOffset,
              paused: state.paused,
              vaultId: state.vaultId.toString(),
            });
          } else {
            output.table(
              ["Property", "Value"],
              [
                ["Authority", formatAddress(state.authority.toBase58())],
                ["Asset Mint", formatAddress(state.assetMint.toBase58())],
                ["Shares Mint", formatAddress(state.sharesMint.toBase58())],
                ["Asset Vault", formatAddress(state.assetVault.toBase58())],
                ["Total Assets", totalAssets.toString()],
                ["Total Shares", totalShares.toString()],
                ["Decimals Offset", state.decimalsOffset.toString()],
                ["Paused", state.paused ? "Yes" : "No"],
                ["Vault ID", state.vaultId.toString()],
              ],
            );
          }
        }
      } catch (error) {
        output.error(
          `Failed to load vault: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
