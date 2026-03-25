/** Balance Command - Show user's share and asset balances for a vault */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { loadVaultClient, resolveVaultArg } from "../../utils";

export function registerBalanceCommand(program: Command): void {
  program
    .command("balance")
    .description("Show user balances for a vault")
    .argument("<vault>", "Vault address or alias")
    .argument("[user]", "User address (defaults to wallet)")
    .option("--variant <variant>", "SVS variant (for raw vault addresses)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, userArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, connection, provider, wallet } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const user = userArg ? new PublicKey(userArg) : wallet.publicKey;

      try {
        const vault = await loadVaultClient(provider, resolved);
        const state = await vault.getState();
        const userAssetAta = vault.getUserAssetAccount(user);
        const userSharesAta = vault.getUserSharesAccount(user);

        let assetBalance = new BN(0);
        let sharesBalance = new BN(0);

        try {
          const assetAccount = await getAccount(
            connection,
            userAssetAta,
            undefined,
            vault.assetTokenProgram,
          );
          assetBalance = new BN(assetAccount.amount.toString());
        } catch {
          // Account doesn't exist
        }

        try {
          const sharesAccount = await getAccount(
            connection,
            userSharesAta,
            undefined,
            TOKEN_2022_PROGRAM_ID,
          );
          sharesBalance = new BN(sharesAccount.amount.toString());
        } catch {
          // Account doesn't exist
        }

        const totalAssets = await vault.totalAssets();
        const totalShares = await vault.totalShares();

        let sharesValue = new BN(0);
        if (!totalShares.isZero()) {
          sharesValue = sharesBalance.mul(totalAssets).div(totalShares);
        }

        if (globalOpts.output === "json") {
          output.json({
            user: user.toBase58(),
            vault: vaultArg,
            assetMint: state.assetMint.toBase58(),
            sharesMint: state.sharesMint.toBase58(),
            assetBalance: assetBalance.toString(),
            sharesBalance: sharesBalance.toString(),
            sharesValue: sharesValue.toString(),
            assetAta: userAssetAta.toBase58(),
            sharesAta: userSharesAta.toBase58(),
          });
        } else {
          output.info(`User: ${user.toBase58()}`);
          output.table(
            ["Token", "Balance", "Value"],
            [
              ["Assets", assetBalance.toString(), "-"],
              [
                "Shares",
                sharesBalance.toString(),
                `≈ ${sharesValue.toString()} assets`,
              ],
            ],
          );
        }
      } catch (error) {
        output.error(
          `Failed to load balances: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
