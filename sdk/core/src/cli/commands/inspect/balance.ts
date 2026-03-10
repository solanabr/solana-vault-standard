/** Balance Command - Show user's share and asset balances for a vault */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Program, BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolanaVault } from "../../../vault";
import { SolVaultSDK } from "../../../svs-7";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";
import { SvsVariant } from "../../types";

export function registerBalanceCommand(program: Command): void {
  program
    .command("balance")
    .description("Show user balances for a vault")
    .argument("<vault>", "Vault address or alias")
    .argument("[user]", "User address (defaults to wallet)")
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
      const variant: SvsVariant | undefined = (opts as any).variant || resolved?.variant;

      const idlPath = findIdlPath(variant);
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);

        // ── SVS-7: native SOL vault ────────────────────────────────────────
        if (variant === "svs-7") {
          const sdk = await SolVaultSDK.load(prog, resolved?.vaultId || new BN(opts.vaultId || 1));
          const userSharesAta = sdk.getUserSharesAccount(user);
          const totalSol = await sdk.totalAssets();
          const totalSupply = await sdk.totalShares();

          let sharesBalance = new BN(0);
          try {
            const acc = await getAccount(connection, userSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
            sharesBalance = new BN(acc.amount.toString());
          } catch { /* account doesn't exist */ }

          let sharesValueLamports = new BN(0);
          if (!totalSupply.isZero()) {
            sharesValueLamports = sharesBalance.mul(totalSol).div(totalSupply);
          }
          const sharesValueSol = (sharesValueLamports.toNumber() / 1e9).toFixed(9);

          const userSolBalance = await connection.getBalance(user);

          if (globalOpts.output === "json") {
            output.json({
              user: user.toBase58(),
              vault: vaultArg,
              nativeSolBalance: userSolBalance.toString(),
              sharesBalance: sharesBalance.toString(),
              sharesValueLamports: sharesValueLamports.toString(),
              sharesValueSol,
              sharesAta: userSharesAta.toBase58(),
            });
          } else {
            output.info(`User: ${user.toBase58()}`);
            output.table(
              ["Token", "Balance", "Value"],
              [
                ["Native SOL", `${(userSolBalance / 1e9).toFixed(9)} SOL`, "-"],
                ["Shares", sharesBalance.toString(), `≈ ${sharesValueSol} SOL`],
              ],
            );
          }
          return;
        }

        // ── SVS-1/2/3/4: SPL token vault ──────────────────────────────────
        const vault = await SolanaVault.load(
          prog,
          resolved.assetMint,
          resolved.vaultId,
        );
        const state = await vault.getState();

        const [userAssetAta, userSharesAta] = await Promise.all([
          getAssociatedTokenAddress(state.assetMint, user),
          getAssociatedTokenAddress(state.sharesMint, user),
        ]);

        let assetBalance = new BN(0);
        let sharesBalance = new BN(0);

        try {
          const assetAccount = await getAccount(connection, userAssetAta);
          assetBalance = new BN(assetAccount.amount.toString());
        } catch {
          // Account doesn't exist
        }

        try {
          const sharesAccount = await getAccount(connection, userSharesAta);
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
