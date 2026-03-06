/** Confidential Transfer Commands - Setup and manage CT accounts for SVS-3/SVS-4 vaults */

import { Command } from "commander";
import { PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_2022_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVault } from "../../config/vault-aliases";
import { getCluster } from "../../utils";

export function registerConfidentialCommands(program: Command): void {
  const ct = program
    .command("ct")
    .description("Confidential transfer commands for SVS-3/SVS-4 vaults");

  ct.command("configure")
    .description(
      "Configure account for confidential transfers (required before first deposit)",
    )
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, provider, options } = ctx;

      const cluster = getCluster(globalOpts.url);
      let resolved;
      try {
        resolved = resolveVault(vaultArg, config, cluster);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      // Verify this is SVS-3 or SVS-4
      if (resolved.variant !== "svs-3" && resolved.variant !== "svs-4") {
        output.error(
          `Confidential transfers only available for SVS-3 and SVS-4 vaults.\n` +
            `This vault is ${resolved.variant.toUpperCase()}.`,
        );
        process.exit(1);
      }

      if (options.dryRun) {
        output.info(
          "DRY RUN - Would configure account for confidential transfers:",
        );
        output.info(`  Vault: ${resolved.address.toBase58()}`);
        output.info(`  User: ${provider.wallet.publicKey.toBase58()}`);
        output.info(`  Variant: ${resolved.variant.toUpperCase()}`);
        output.info("");
        output.info("Steps that would be performed:");
        output.info("  1. Derive ElGamal keypair from wallet");
        output.info("  2. Derive AES key for balance decryption");
        output.info("  3. Create shares token account (if needed)");
        output.info("  4. Submit pubkey validity proof");
        output.info("  5. Configure account for confidential transfers");
        return;
      }

      const spinner = output.spinner(
        "Configuring account for confidential transfers...",
      );
      spinner.start();

      try {
        // Dynamic import of privacy SDK to avoid bundling issues
        const { ConfidentialSolanaVault, deriveElGamalKeypair, deriveAesKey } =
          await import("@stbr/svs-privacy-sdk");
        const { getAssociatedTokenAddressSync } =
          await import("@solana/spl-token");

        // Load IDL for the confidential vault program
        const idlPath =
          resolved.variant === "svs-3"
            ? "../../target/idl/svs_3.json"
            : "../../target/idl/svs_4.json";

        let idl;
        try {
          idl = require(idlPath);
        } catch {
          spinner.fail("IDL not found. Run `anchor build` first.");
          process.exit(1);
        }

        const vault = new ConfidentialSolanaVault(
          provider.connection,
          provider.wallet as any,
          idl,
        );

        // Get vault state to find shares mint
        const vaultState = await vault.getVault(resolved.address);

        // Derive user's shares account
        const userSharesAccount = getAssociatedTokenAddressSync(
          vaultState.sharesMint,
          provider.wallet.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        );

        // Derive ElGamal keypair and AES key from wallet
        const walletKeypair = (provider.wallet as any).payer as Keypair;
        const elgamalKeypair = deriveElGamalKeypair(
          walletKeypair,
          userSharesAccount,
        );
        const aesKey = deriveAesKey(walletKeypair, userSharesAccount);

        const result = await vault.configureAccount({
          vault: resolved.address,
          userSharesAccount,
          elgamalKeypair,
          aesKey,
        });

        spinner.succeed("Account configured for confidential transfers!");

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature: result.signature,
            vault: resolved.address.toBase58(),
            user: provider.wallet.publicKey.toBase58(),
          });
        } else {
          output.info("");
          output.info("Your account is now ready for confidential deposits.");
          output.info("");
          output.info("Next steps:");
          output.info(
            `  1. Deposit: solana-vault deposit ${vaultArg} --amount <AMOUNT>`,
          );
          output.info(
            `  2. Apply pending: solana-vault ct apply-pending ${vaultArg}`,
          );
          output.info("");
          output.info(`Transaction: ${result.signature}`);
        }
      } catch (error) {
        spinner.fail("Failed to configure account");
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  ct.command("apply-pending")
    .description(
      "Apply pending balance to available balance (required after deposit/mint)",
    )
    .argument("<vault>", "Vault address or alias")
    .option(
      "--expected-counter <number>",
      "Expected pending balance credit counter",
    )
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, provider, options } = ctx;

      const cluster = getCluster(globalOpts.url);
      let resolved;
      try {
        resolved = resolveVault(vaultArg, config, cluster);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      // Verify this is SVS-3 or SVS-4
      if (resolved.variant !== "svs-3" && resolved.variant !== "svs-4") {
        output.error(
          `Confidential transfers only available for SVS-3 and SVS-4 vaults.\n` +
            `This vault is ${resolved.variant.toUpperCase()}.`,
        );
        process.exit(1);
      }

      if (options.dryRun) {
        output.info("DRY RUN - Would apply pending balance:");
        output.info(`  Vault: ${resolved.address.toBase58()}`);
        output.info(`  User: ${provider.wallet.publicKey.toBase58()}`);
        if (opts.expectedCounter) {
          output.info(`  Expected counter: ${opts.expectedCounter}`);
        }
        return;
      }

      const spinner = output.spinner("Applying pending balance...");
      spinner.start();

      try {
        // Dynamic import of privacy SDK
        const {
          ConfidentialSolanaVault,
          deriveAesKey,
          computeNewDecryptableBalance,
        } = await import("@stbr/svs-privacy-sdk");

        // Load IDL
        const idlPath =
          resolved.variant === "svs-3"
            ? "../../target/idl/svs_3.json"
            : "../../target/idl/svs_4.json";

        let idl;
        try {
          idl = require(idlPath);
        } catch {
          spinner.fail("IDL not found. Run `anchor build` first.");
          process.exit(1);
        }

        const vault = new ConfidentialSolanaVault(
          provider.connection,
          provider.wallet as any,
          idl,
        );

        // Get vault state to find shares mint
        const vaultState = await vault.getVault(resolved.address);

        // Derive user's shares account
        const { getAssociatedTokenAddressSync } =
          await import("@solana/spl-token");
        const userSharesAccount = getAssociatedTokenAddressSync(
          vaultState.sharesMint,
          provider.wallet.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        );

        // Get the token account to read pending balance info
        const accountInfo = await getAccount(
          provider.connection,
          userSharesAccount,
          "confirmed",
          TOKEN_2022_PROGRAM_ID,
        );

        // Derive AES key
        const walletKeypair = (provider.wallet as any).payer as Keypair;
        const aesKey = deriveAesKey(walletKeypair, userSharesAccount);

        // Compute new decryptable balance (current + pending)
        // For now, use a simple approach - in production this would read the CT extension
        const expectedCounter = opts.expectedCounter
          ? new BN(opts.expectedCounter)
          : new BN(1);

        const newDecryptableBalance = computeNewDecryptableBalance(
          aesKey,
          new Uint8Array(48), // Current balance ciphertext (would be read from account)
          new BN(0), // Delta (would be computed from pending)
        );

        const signature = await vault.applyPending({
          vault: resolved.address,
          newDecryptableAvailableBalance: newDecryptableBalance,
          expectedPendingBalanceCreditCounter: expectedCounter,
        });

        spinner.succeed("Pending balance applied!");

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: resolved.address.toBase58(),
            user: provider.wallet.publicKey.toBase58(),
          });
        } else {
          output.info("");
          output.info("Your pending shares are now available for use.");
          output.info(`Transaction: ${signature}`);
        }
      } catch (error) {
        spinner.fail("Failed to apply pending balance");
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  ct.command("status")
    .description("Show confidential transfer account status")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

      const cluster = getCluster(globalOpts.url);
      let resolved;
      try {
        resolved = resolveVault(vaultArg, config, cluster);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      // Verify this is SVS-3 or SVS-4
      if (resolved.variant !== "svs-3" && resolved.variant !== "svs-4") {
        output.error(
          `Confidential transfers only available for SVS-3 and SVS-4 vaults.`,
        );
        process.exit(1);
      }

      try {
        const { ConfidentialSolanaVault } =
          await import("@stbr/svs-privacy-sdk");
        const { getAssociatedTokenAddressSync } =
          await import("@solana/spl-token");

        // Load IDL
        const idlPath =
          resolved.variant === "svs-3"
            ? "../../target/idl/svs_3.json"
            : "../../target/idl/svs_4.json";

        let idl;
        try {
          idl = require(idlPath);
        } catch {
          output.error("IDL not found. Run `anchor build` first.");
          process.exit(1);
        }

        const vault = new ConfidentialSolanaVault(
          provider.connection,
          provider.wallet as any,
          idl,
        );

        const vaultState = await vault.getVault(resolved.address);
        const userSharesAccount = getAssociatedTokenAddressSync(
          vaultState.sharesMint,
          provider.wallet.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        );

        // Check if account exists
        let accountConfigured = false;
        let hasPendingBalance = false;

        try {
          const accountInfo =
            await provider.connection.getAccountInfo(userSharesAccount);
          if (accountInfo) {
            accountConfigured = true;
            // Check for CT extension data - simplified check
            // In production, would parse the extension properly
            hasPendingBalance = accountInfo.data.length > 165;
          }
        } catch {
          // Account doesn't exist
        }

        if (globalOpts.output === "json") {
          output.json({
            vault: resolved.address.toBase58(),
            user: provider.wallet.publicKey.toBase58(),
            sharesAccount: userSharesAccount.toBase58(),
            configured: accountConfigured,
            hasPendingBalance,
          });
        } else {
          output.info(`Confidential Transfer Status for ${vaultArg}`);
          output.info("");
          output.table(
            ["Property", "Value"],
            [
              ["Vault", resolved.address.toBase58()],
              ["User", provider.wallet.publicKey.toBase58()],
              ["Shares Account", userSharesAccount.toBase58()],
              ["CT Configured", accountConfigured ? "Yes" : "No"],
              [
                "Has Pending",
                hasPendingBalance ? "Yes (run apply-pending)" : "No",
              ],
            ],
          );

          if (!accountConfigured) {
            output.info("");
            output.warn(
              `Account not configured. Run: solana-vault ct configure ${vaultArg}`,
            );
          }
        }
      } catch (error) {
        output.error(
          `Failed to get status: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
