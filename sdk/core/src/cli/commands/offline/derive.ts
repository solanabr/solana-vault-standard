/** Derive Command - Derive vault PDA addresses offline (no RPC needed) */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { deriveVaultAddresses } from "../../../pda";

export function registerDeriveCommand(program: Command): void {
  program
    .command("derive")
    .description("Derive vault PDA addresses (no RPC needed)")
    .requiredOption("--program-id <pubkey>", "Program ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, false, false);
      const { output } = ctx;

      let programId: PublicKey;
      let assetMint: PublicKey;

      try {
        programId = new PublicKey(opts.programId);
      } catch {
        output.error(`Invalid program ID: ${opts.programId}`);
        process.exit(1);
      }

      try {
        assetMint = new PublicKey(opts.assetMint);
      } catch {
        output.error(`Invalid asset mint: ${opts.assetMint}`);
        process.exit(1);
      }

      const vaultId = new BN(opts.vaultId);
      const addresses = deriveVaultAddresses(programId, assetMint, vaultId);

      if (globalOpts.output === "json") {
        output.json({
          vault: {
            address: addresses.vault.toBase58(),
            bump: addresses.vaultBump,
          },
          sharesMint: {
            address: addresses.sharesMint.toBase58(),
            bump: addresses.sharesMintBump,
          },
          inputs: {
            programId: programId.toBase58(),
            assetMint: assetMint.toBase58(),
            vaultId: vaultId.toString(),
          },
        });
      } else {
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
    });
}
