/** Derive Command - Derive vault PDA addresses offline (no RPC needed) */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import {
  deriveAsyncVaultAddresses,
  deriveVaultAddresses,
  getClaimableEscrowAddress,
  getDepositRequestAddress,
  getOperatorApprovalAddress,
  getRedeemRequestAddress,
} from "../../../pda";
import { parseVariant } from "../../utils";

export function registerDeriveCommand(program: Command): void {
  program
    .command("derive")
    .description("Derive vault PDA addresses (no RPC needed)")
    .requiredOption("--program-id <pubkey>", "Program ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant", "svs-1")
    .option("--owner <pubkey>", "Owner for async request PDAs")
    .option("--operator <pubkey>", "Operator for async approval PDA")
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
      const variant = parseVariant(opts.variant);
      if (!variant) {
        output.error(`Invalid variant: ${opts.variant}`);
        process.exit(1);
      }

      let owner: PublicKey | undefined;
      let operator: PublicKey | undefined;

      try {
        owner = opts.owner ? new PublicKey(opts.owner) : undefined;
      } catch {
        output.error(`Invalid owner: ${opts.owner}`);
        process.exit(1);
      }

      try {
        operator = opts.operator ? new PublicKey(opts.operator) : undefined;
      } catch {
        output.error(`Invalid operator: ${opts.operator}`);
        process.exit(1);
      }

      if (variant !== "svs-10") {
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
              variant,
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
        return;
      }

      const addresses = deriveAsyncVaultAddresses(programId, assetMint, vaultId);
      const asyncRows = [
        [
          "Async Vault PDA",
          addresses.vault.toBase58(),
          addresses.vaultBump.toString(),
        ],
        [
          "Shares Mint",
          addresses.sharesMint.toBase58(),
          addresses.sharesMintBump.toString(),
        ],
        [
          "Share Escrow",
          addresses.shareEscrow.toBase58(),
          addresses.shareEscrowBump.toString(),
        ],
      ];

      if (owner) {
        const [depositRequest, depositRequestBump] = getDepositRequestAddress(
          programId,
          addresses.vault,
          owner,
        );
        const [redeemRequest, redeemRequestBump] = getRedeemRequestAddress(
          programId,
          addresses.vault,
          owner,
        );
        const [claimableEscrow, claimableEscrowBump] =
          getClaimableEscrowAddress(programId, addresses.vault, owner);

        asyncRows.push(
          [
            "Deposit Request",
            depositRequest.toBase58(),
            depositRequestBump.toString(),
          ],
          [
            "Redeem Request",
            redeemRequest.toBase58(),
            redeemRequestBump.toString(),
          ],
          [
            "Claimable Escrow",
            claimableEscrow.toBase58(),
            claimableEscrowBump.toString(),
          ],
        );

        if (operator) {
          const [operatorApproval, operatorApprovalBump] =
            getOperatorApprovalAddress(
              programId,
              addresses.vault,
              owner,
              operator,
            );
          asyncRows.push([
            "Operator Approval",
            operatorApproval.toBase58(),
            operatorApprovalBump.toString(),
          ]);
        }
      }

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
          shareEscrow: {
            address: addresses.shareEscrow.toBase58(),
            bump: addresses.shareEscrowBump,
          },
          inputs: {
            programId: programId.toBase58(),
            assetMint: assetMint.toBase58(),
            vaultId: vaultId.toString(),
            variant,
            owner: owner?.toBase58(),
            operator: operator?.toBase58(),
          },
        });
      } else {
        output.table(["Type", "Address", "Bump"], asyncRows);
      }
    });
}
