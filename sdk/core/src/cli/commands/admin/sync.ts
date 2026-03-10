/** Sync Command - Sync stored balance with actual vault balance (SVS-2/4/7) */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVault, isValidPublicKey } from "../../config/vault-aliases";
import { ManagedVault } from "../../../managed-vault";
import { SolVaultSDK } from "../../../svs-7";
import { findIdlPath, loadIdl, checkAuthority } from "../../utils";
import { SvsVariant } from "../../types";

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Sync stored balance with actual vault balance (SVS-2/4/7-stored only)")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, connection, provider, wallet, options } = ctx;

      let assetMint: PublicKey;
      let vaultId: BN;
      let variant: SvsVariant = "svs-2";

      if (isValidPublicKey(vaultArg)) {
        if (!opts.programId || !opts.assetMint) {
          output.error(
            "When using raw vault address, --program-id and --asset-mint are required",
          );
          process.exit(1);
        }
        assetMint = new PublicKey(opts.assetMint);
        vaultId = new BN(opts.vaultId);
      } else {
        try {
          const resolved = resolveVault(vaultArg, config);
          variant = resolved.variant;

          if (variant !== "svs-2" && variant !== "svs-4" && variant !== "svs-7") {
            output.error(`Sync only available for SVS-2/SVS-4/SVS-7 (Stored). This vault is ${variant}.`);
            process.exit(1);
          }

          if (!resolved.assetMint) {
            output.error(
              `Vault "${vaultArg}" missing assetMint. Update with:\n` +
              `  solana-vault config update-vault ${vaultArg} --asset-mint <ADDRESS>`,
            );
            process.exit(1);
          }
          assetMint = resolved.assetMint;
          vaultId = resolved.vaultId || new BN(opts.vaultId);
        } catch (error) {
          output.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      }

      const idlPath = findIdlPath(variant);
      if (!idlPath) {
        output.error(
          `IDL for ${variant} not found. Run \`anchor build\` first.`,
        );
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);

        // ── SVS-7: native SOL vault (Stored model) ─────────────────────────
        if (variant === "svs-7") {
          const sdk = await SolVaultSDK.load(prog, vaultId);
          const state = await sdk.getState();
          const wsolBalance = await sdk.totalAssets();
          const storedBalance = state.totalAssets;

          output.info(`Vault: ${vaultArg}`);
          output.info(`wSOL vault balance: ${wsolBalance.toString()}`);
          output.info(`Stored total_assets: ${storedBalance.toString()}`);

          if (wsolBalance.eq(storedBalance)) {
            output.success("Already in sync. No action needed.");
            return;
          }

          if (options.dryRun) {
            output.success("Dry run complete. No transaction sent.");
            return;
          }
          if (!options.yes) {
            const confirmed = await output.confirm("Sync SVS-7 vault balance?");
            if (!confirmed) { output.warn("Aborted."); return; }
          }

          const spinner = output.spinner("Syncing vault...");
          spinner.start();
          const signature = await sdk.sync();
          spinner.succeed("Vault synced");
          output.info(`New stored balance: ${wsolBalance.toString()}`);
          output.info(`Signature: ${signature}`);
          if (globalOpts.output === "json") {
            output.json({ success: true, signature, vault: vaultArg, operation: "sync", newBalance: wsolBalance.toString() });
          }
          return;
        }

        // ── SVS-2/4: SPL token stored-balance vault ──────────────────────
        const vault = await ManagedVault.load(prog, assetMint, vaultId);
        const state = await vault.getState();

        if (!checkAuthority(wallet.publicKey, state.authority, output)) {
          process.exit(1);
        }

        const storedBalance = await vault.storedTotalAssets();
        const assetVaultAccount = await getAccount(
          connection,
          state.assetVault,
        );
        const liveBalance = new BN(assetVaultAccount.amount.toString());
        const diff = liveBalance.sub(storedBalance);

        output.info(`Vault: ${vaultArg}`);
        output.info(`Stored balance:  ${storedBalance.toString()}`);
        output.info(`Live balance:    ${liveBalance.toString()}`);

        if (diff.isZero()) {
          output.success("Already in sync. No action needed.");
          return;
        }

        const diffSign = diff.isNeg() ? "" : "+";
        output.info(`Difference:      ${diffSign}${diff.toString()}`);

        if (options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          if (globalOpts.output === "json") {
            output.json({
              dryRun: true,
              vault: vaultArg,
              operation: "sync",
              storedBalance: storedBalance.toString(),
              liveBalance: liveBalance.toString(),
              difference: diff.toString(),
            });
          }
          return;
        }

        if (!options.yes) {
          const confirmed = await output.confirm("Sync vault balance?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Syncing vault...");
        spinner.start();

        const signature = await vault.sync(wallet.publicKey);

        spinner.succeed("Vault synced");
        output.info(`New stored balance: ${liveBalance.toString()}`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "sync",
            previousBalance: storedBalance.toString(),
            newBalance: liveBalance.toString(),
            difference: diff.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
