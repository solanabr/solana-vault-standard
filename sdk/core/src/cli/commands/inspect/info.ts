/** Info Command - Display vault state, addresses, and statistics */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVault, isValidPublicKey } from "../../config/vault-aliases";
import { SolanaVault } from "../../../vault";
import { deriveVaultAddresses } from "../../../pda";
import { formatAddress } from "../../output";
import { findIdlPath, loadIdl } from "../../utils";

export function registerInfoCommand(program: Command): void {
  program
    .command("info")
    .description("Show vault state and information")
    .argument("[vault]", "Vault address or alias")
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
      const { output, config, connection, provider } = ctx;

      let programId: PublicKey;
      let assetMint: PublicKey | undefined;
      let vaultId: BN;
      let vaultAddress: PublicKey | undefined;

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
      } else if (vaultArg) {
        try {
          const resolved = resolveVault(vaultArg, config);
          vaultAddress = resolved.address;
          programId = resolved.programId;
          assetMint = resolved.assetMint;
          vaultId = resolved.vaultId || new BN(opts.vaultId);
        } catch (error) {
          output.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      } else if (opts.programId && opts.assetMint) {
        programId = new PublicKey(opts.programId);
        assetMint = new PublicKey(opts.assetMint);
        vaultId = new BN(opts.vaultId);
      } else {
        output.error(
          "Provide a vault address/alias, or --program-id and --asset-mint",
        );
        process.exit(1);
      }

      if (assetMint) {
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

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.warn("IDL not found. Run `anchor build` to generate IDL.");
        output.info("Showing derived addresses only.");
        return;
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);

        if (!assetMint) {
          output.error("Asset mint required to load vault state");
          process.exit(1);
        }

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
      } catch (error) {
        output.error(
          `Failed to load vault: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
