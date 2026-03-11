/**
 * Async Vault Commands (SVS-10)
 *
 * CLI commands for ERC-7540 async vault lifecycle:
 * request-deposit, cancel-deposit, claim-deposit,
 * request-redeem, cancel-redeem, claim-redeem,
 * fulfill-deposit, fulfill-redeem (operator),
 * init-oracle, update-oracle (admin),
 * show-request (view)
 */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import {
  resolveVaultArg,
  findIdlPath,
  loadIdl,
  isValidPublicKey,
  formatNumber,
} from "../../utils";
import { AsyncVault } from "../../../async-vault";
import {
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableEscrowAddress,
  getOraclePriceAddress,
} from "../../../async-pda";

/**
 * Load AsyncVault instance from CLI args.
 * Resolves vault alias, loads IDL, and returns a ready-to-use AsyncVault.
 */
async function loadAsyncVault(
  program: Command,
  vaultArg: string,
  opts: Record<string, unknown>,
): Promise<{
  vault: AsyncVault;
  ctx: Awaited<ReturnType<typeof createContext>>;
}> {
  const globalOpts = getGlobalOptions(program);
  const ctx = await createContext(globalOpts, opts, true, true);
  const { output, config, provider } = ctx;

  const resolved = resolveVaultArg(vaultArg, config, opts as any, output);
  if (!resolved) process.exit(1);

  if (resolved.variant !== "svs-10") {
    output.error(
      `This command is for SVS-10 async vaults only. Vault "${vaultArg}" is ${resolved.variant}.`,
    );
    process.exit(1);
  }

  const idlPath = findIdlPath("svs-10");
  if (!idlPath) {
    output.error("SVS-10 IDL not found. Run `anchor build -p svs-10` first.");
    process.exit(1);
  }

  const idl = loadIdl(idlPath);
  const prog = new Program(idl as any, provider);
  const vault = await AsyncVault.load(
    prog as any,
    resolved.assetMint,
    resolved.vaultId,
  );

  return { vault, ctx };
}

export function registerAsyncVaultCommands(program: Command): void {
  const async = program
    .command("async")
    .description("Async vault operations (SVS-10 ERC-7540)");

  // ============================================================================
  // User Commands
  // ============================================================================

  async
    .command("request-deposit")
    .description("Request a deposit into an async vault")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-a, --amount <number>", "Amount of assets to deposit")
    .option("--receiver <pubkey>", "Receiver of shares (defaults to wallet)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      const amount = new BN(opts.amount);
      const receiver = opts.receiver
        ? new PublicKey(opts.receiver)
        : wallet.publicKey;

      output.info(`Vault: ${vaultArg}`);
      output.info(`Requesting deposit: ${formatNumber(amount)} assets`);
      output.info(`Receiver: ${receiver.toBase58()}`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        if (globalOpts.output === "json") {
          output.json({
            dryRun: true,
            vault: vaultArg,
            operation: "request-deposit",
            assets: amount.toString(),
            receiver: receiver.toBase58(),
          });
        }
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Proceed with deposit request?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.requestDeposit(wallet, amount, receiver);

        spinner.succeed("Deposit request submitted");
        output.success(`Requested deposit of ${formatNumber(amount)} assets`);
        output.info(`Signature: ${signature}`);
        output.info(
          "An operator must fulfill this request before shares can be claimed.",
        );

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "request-deposit",
            assets: amount.toString(),
            receiver: receiver.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Request deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  async
    .command("cancel-deposit")
    .description("Cancel a pending deposit request")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      const pending = await vault.pendingDepositRequest(wallet.publicKey);
      if (pending.isZero()) {
        output.warn("No pending deposit request found for your wallet.");
        return;
      }

      output.info(`Vault: ${vaultArg}`);
      output.info(`Cancelling deposit of ${formatNumber(pending)} assets`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Cancel deposit request?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.cancelDeposit(wallet);

        spinner.succeed("Deposit request cancelled");
        output.success(`Assets returned to your wallet`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "cancel-deposit",
            assetsReturned: pending.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Cancel deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  async
    .command("claim-deposit")
    .description("Claim shares from a fulfilled deposit")
    .argument("<vault>", "Vault address or alias")
    .option("--owner <pubkey>", "Request owner (defaults to wallet)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      const owner = opts.owner ? new PublicKey(opts.owner) : wallet.publicKey;

      const claimable = await vault.claimableDepositRequest(owner);
      if (claimable.isZero()) {
        output.warn(
          "No claimable deposit found. Request may still be pending.",
        );
        return;
      }

      output.info(`Vault: ${vaultArg}`);
      output.info(`Claimable shares: ${formatNumber(claimable)}`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Claim deposit shares?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.claimDeposit(wallet, owner);

        spinner.succeed("Deposit claimed");
        output.success(`Claimed ${formatNumber(claimable)} shares`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "claim-deposit",
            sharesClaimed: claimable.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Claim deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  async
    .command("request-redeem")
    .description("Request redemption of shares for assets")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-s, --shares <number>", "Amount of shares to redeem")
    .option("--receiver <pubkey>", "Receiver of assets (defaults to wallet)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      const shares = new BN(opts.shares);
      const receiver = opts.receiver
        ? new PublicKey(opts.receiver)
        : wallet.publicKey;

      output.info(`Vault: ${vaultArg}`);
      output.info(`Requesting redeem: ${formatNumber(shares)} shares`);
      output.info(`Receiver: ${receiver.toBase58()}`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        if (globalOpts.output === "json") {
          output.json({
            dryRun: true,
            vault: vaultArg,
            operation: "request-redeem",
            shares: shares.toString(),
            receiver: receiver.toBase58(),
          });
        }
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Proceed with redeem request?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.requestRedeem(wallet, shares, receiver);

        spinner.succeed("Redeem request submitted");
        output.success(
          `Requested redemption of ${formatNumber(shares)} shares`,
        );
        output.info(`Signature: ${signature}`);
        output.info(
          "An operator must fulfill this request before assets can be claimed.",
        );

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "request-redeem",
            shares: shares.toString(),
            receiver: receiver.toBase58(),
          });
        }
      } catch (error) {
        output.error(
          `Request redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  async
    .command("cancel-redeem")
    .description("Cancel a pending redeem request")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      const pending = await vault.pendingRedeemRequest(wallet.publicKey);
      if (pending.isZero()) {
        output.warn("No pending redeem request found for your wallet.");
        return;
      }

      output.info(`Vault: ${vaultArg}`);
      output.info(`Cancelling redeem of ${formatNumber(pending)} shares`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Cancel redeem request?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.cancelRedeem(wallet);

        spinner.succeed("Redeem request cancelled");
        output.success(`Shares returned to your wallet`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "cancel-redeem",
            sharesReturned: pending.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Cancel redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  async
    .command("claim-redeem")
    .description("Claim assets from a fulfilled redemption")
    .argument("<vault>", "Vault address or alias")
    .option("--owner <pubkey>", "Request owner (defaults to wallet)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      const owner = opts.owner ? new PublicKey(opts.owner) : wallet.publicKey;

      const claimable = await vault.claimableRedeemRequest(owner);
      if (claimable.isZero()) {
        output.warn(
          "No claimable redemption found. Request may still be pending.",
        );
        return;
      }

      output.info(`Vault: ${vaultArg}`);
      output.info(`Claimable assets: ${formatNumber(claimable)}`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Claim redeemed assets?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.claimRedeem(wallet, owner);

        spinner.succeed("Redemption claimed");
        output.success(`Claimed ${formatNumber(claimable)} assets`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "claim-redeem",
            assetsClaimed: claimable.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Claim redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  // ============================================================================
  // Operator Commands
  // ============================================================================

  async
    .command("fulfill-deposit")
    .description("Fulfill a pending deposit request (operator only)")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--owner <pubkey>", "Deposit request owner address")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      if (!isValidPublicKey(opts.owner)) {
        output.error("Invalid owner address");
        process.exit(1);
      }
      const owner = new PublicKey(opts.owner);

      const pending = await vault.pendingDepositRequest(owner);
      if (pending.isZero()) {
        output.warn(`No pending deposit request for ${owner.toBase58()}`);
        return;
      }

      output.info(`Vault: ${vaultArg}`);
      output.info(`Fulfilling deposit for: ${owner.toBase58()}`);
      output.info(`Assets locked: ${formatNumber(pending)}`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Fulfill this deposit request?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.fulfillDeposit(wallet, owner);

        spinner.succeed("Deposit fulfilled");
        output.success(`Deposit request fulfilled for ${owner.toBase58()}`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "fulfill-deposit",
            owner: owner.toBase58(),
            assetsLocked: pending.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Fulfill deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  async
    .command("fulfill-redeem")
    .description("Fulfill a pending redeem request (operator only)")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--owner <pubkey>", "Redeem request owner address")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      if (!isValidPublicKey(opts.owner)) {
        output.error("Invalid owner address");
        process.exit(1);
      }
      const owner = new PublicKey(opts.owner);

      const pending = await vault.pendingRedeemRequest(owner);
      if (pending.isZero()) {
        output.warn(`No pending redeem request for ${owner.toBase58()}`);
        return;
      }

      output.info(`Vault: ${vaultArg}`);
      output.info(`Fulfilling redeem for: ${owner.toBase58()}`);
      output.info(`Shares locked: ${formatNumber(pending)}`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Fulfill this redeem request?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.fulfillRedeem(wallet, owner);

        spinner.succeed("Redeem fulfilled");
        output.success(`Redeem request fulfilled for ${owner.toBase58()}`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "fulfill-redeem",
            owner: owner.toBase58(),
            sharesLocked: pending.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Fulfill redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  // ============================================================================
  // Admin Commands
  // ============================================================================

  async
    .command("init-oracle")
    .description("Initialize oracle price account for a vault (admin only)")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--price <number>", "Initial price (raw u64)")
    .option(
      "--oracle-authority <pubkey>",
      "Oracle update authority (defaults to wallet)",
    )
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      const price = new BN(opts.price);
      const oracleAuthority = opts.oracleAuthority
        ? new PublicKey(opts.oracleAuthority)
        : wallet.publicKey;

      const [oraclePda] = getOraclePriceAddress(vault.programId, vault.address);

      output.info(`Vault: ${vaultArg}`);
      output.info(`Oracle PDA: ${oraclePda.toBase58()}`);
      output.info(`Initial price: ${price.toString()}`);
      output.info(`Oracle authority: ${oracleAuthority.toBase58()}`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        if (globalOpts.output === "json") {
          output.json({
            dryRun: true,
            vault: vaultArg,
            operation: "init-oracle",
            oraclePda: oraclePda.toBase58(),
            price: price.toString(),
            oracleAuthority: oracleAuthority.toBase58(),
          });
        }
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Initialize oracle?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.program.methods
          .initializeOracle(price, oracleAuthority)
          .accountsStrict({
            authority: wallet.publicKey,
            vault: vault.address,
            oraclePrice: oraclePda,
            systemProgram: new PublicKey("11111111111111111111111111111111"),
          })
          .signers([wallet])
          .rpc();

        spinner.succeed("Oracle initialized");
        output.success(`Oracle price set to ${price.toString()}`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "init-oracle",
            oraclePda: oraclePda.toBase58(),
            price: price.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Init oracle failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  async
    .command("update-oracle")
    .description("Update oracle price (oracle authority only)")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--price <number>", "New price (raw u64)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet, options } = ctx;
      const globalOpts = getGlobalOptions(program);

      const price = new BN(opts.price);
      const [oraclePda] = getOraclePriceAddress(vault.programId, vault.address);

      output.info(`Vault: ${vaultArg}`);
      output.info(`New price: ${price.toString()}`);

      if (options.dryRun) {
        output.success("Dry run complete. No transaction sent.");
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm("Update oracle price?");
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.program.methods
          .updateOraclePrice(price)
          .accountsStrict({
            oracleAuthority: wallet.publicKey,
            vault: vault.address,
            oraclePrice: oraclePda,
          })
          .signers([wallet])
          .rpc();

        spinner.succeed("Oracle price updated");
        output.success(`Price set to ${price.toString()}`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            vault: vaultArg,
            operation: "update-oracle",
            price: price.toString(),
          });
        }
      } catch (error) {
        output.error(
          `Update oracle failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  // ============================================================================
  // View Commands
  // ============================================================================

  async
    .command("show-request")
    .description("Show deposit/redeem request status for an async vault")
    .argument("<vault>", "Vault address or alias")
    .option("--owner <pubkey>", "Request owner (defaults to wallet)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const { vault, ctx } = await loadAsyncVault(program, vaultArg, opts);
      const { output, wallet } = ctx;
      const globalOpts = getGlobalOptions(program);

      const owner = opts.owner ? new PublicKey(opts.owner) : wallet.publicKey;

      const [depositPda] = getDepositRequestAddress(
        vault.programId,
        vault.address,
        owner,
      );
      const [redeemPda] = getRedeemRequestAddress(
        vault.programId,
        vault.address,
        owner,
      );
      const [claimablePda] = getClaimableEscrowAddress(
        vault.programId,
        vault.address,
        owner,
      );
      const [oraclePda] = getOraclePriceAddress(vault.programId, vault.address);

      try {
        const connection = vault.program.provider.connection;

        // Fetch all accounts in parallel
        const [depositInfo, redeemInfo, claimableInfo, oracleInfo] =
          await connection.getMultipleAccountsInfo([
            depositPda,
            redeemPda,
            claimablePda,
            oraclePda,
          ]);

        // Build status data
        const depositStatus = depositInfo
          ? await vault.program.account.depositRequest
              .fetch(depositPda)
              .catch(() => null)
          : null;

        const redeemStatus = redeemInfo
          ? await vault.program.account.redeemRequest
              .fetch(redeemPda)
              .catch(() => null)
          : null;

        const claimableStatus = claimableInfo
          ? await vault.program.account.claimableEscrow
              .fetch(claimablePda)
              .catch(() => null)
          : null;

        const oracleStatus = oracleInfo
          ? await vault.program.account.oraclePrice
              .fetch(oraclePda)
              .catch(() => null)
          : null;

        if (globalOpts.output === "json") {
          output.json({
            vault: vaultArg,
            owner: owner.toBase58(),
            vaultState: {
              totalAssets: vault.state.totalAssets.toString(),
              totalShares: vault.state.totalShares.toString(),
              paused: vault.state.paused,
              operator: vault.state.operator.toBase58(),
            },
            depositRequest: depositStatus
              ? {
                  assetsLocked: depositStatus.assetsLocked.toString(),
                  sharesClaimable: depositStatus.sharesClaimable.toString(),
                  status: formatRequestStatus(depositStatus.status),
                  requestedAt: depositStatus.requestedAt.toString(),
                  fulfilledAt: depositStatus.fulfilledAt.toString(),
                }
              : null,
            redeemRequest: redeemStatus
              ? {
                  sharesLocked: redeemStatus.sharesLocked.toString(),
                  assetsClaimable: redeemStatus.assetsClaimable.toString(),
                  status: formatRequestStatus(redeemStatus.status),
                  requestedAt: redeemStatus.requestedAt.toString(),
                  fulfilledAt: redeemStatus.fulfilledAt.toString(),
                }
              : null,
            claimableEscrow: claimableStatus
              ? { amount: claimableStatus.amount.toString() }
              : null,
            oracle: oracleStatus
              ? {
                  price: oracleStatus.price.toString(),
                  updatedAt: oracleStatus.updatedAt.toString(),
                  authority: oracleStatus.authority.toBase58(),
                }
              : null,
          });
          return;
        }

        output.info(`Async Vault Status: ${vaultArg}`);
        output.info(`Owner: ${owner.toBase58()}\n`);

        // Vault state
        output.table(
          ["Property", "Value"],
          [
            ["Total Assets", formatNumber(vault.state.totalAssets)],
            ["Total Shares", formatNumber(vault.state.totalShares)],
            ["Paused", vault.state.paused ? "Yes" : "No"],
            ["Operator", vault.state.operator.toBase58()],
          ],
        );

        output.info("");

        // Deposit request
        if (depositStatus) {
          output.info("Deposit Request:");
          output.table(
            ["Field", "Value"],
            [
              ["Status", formatRequestStatus(depositStatus.status)],
              ["Assets Locked", formatNumber(depositStatus.assetsLocked)],
              ["Shares Claimable", formatNumber(depositStatus.sharesClaimable)],
              [
                "Requested At",
                new Date(
                  depositStatus.requestedAt.toNumber() * 1000,
                ).toISOString(),
              ],
            ],
          );
        } else {
          output.info("Deposit Request: None");
        }

        output.info("");

        // Redeem request
        if (redeemStatus) {
          output.info("Redeem Request:");
          output.table(
            ["Field", "Value"],
            [
              ["Status", formatRequestStatus(redeemStatus.status)],
              ["Shares Locked", formatNumber(redeemStatus.sharesLocked)],
              ["Assets Claimable", formatNumber(redeemStatus.assetsClaimable)],
              [
                "Requested At",
                new Date(
                  redeemStatus.requestedAt.toNumber() * 1000,
                ).toISOString(),
              ],
            ],
          );
        } else {
          output.info("Redeem Request: None");
        }

        output.info("");

        // Claimable escrow
        if (claimableStatus) {
          output.info(
            `Claimable Escrow: ${formatNumber(claimableStatus.amount)} assets`,
          );
        }

        // Oracle
        if (oracleStatus) {
          output.info("");
          output.info("Oracle:");
          output.table(
            ["Field", "Value"],
            [
              ["Price", oracleStatus.price.toString()],
              [
                "Updated At",
                new Date(
                  oracleStatus.updatedAt.toNumber() * 1000,
                ).toISOString(),
              ],
              ["Authority", oracleStatus.authority.toBase58()],
            ],
          );
        }
      } catch (error) {
        output.error(
          `Failed to fetch request status: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}

function formatRequestStatus(status: Record<string, unknown>): string {
  if ("pending" in status) return "Pending";
  if ("fulfilled" in status) return "Fulfilled";
  if ("claimed" in status) return "Claimed";
  if ("cancelled" in status) return "Cancelled";
  return "Unknown";
}
