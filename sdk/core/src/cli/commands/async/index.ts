/** Async Commands - Manage SVS-10 request/fulfill/claim flows */

import { Command } from "commander";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { AsyncVault } from "../../../async-vault";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { findIdlPath, loadIdl, resolveVaultArg } from "../../utils";
import { CliContext, GlobalOptions } from "../../types";

interface CommonVaultOptions {
  programId?: string;
  assetMint?: string;
  vaultId?: string;
  variant?: string;
}

interface AsyncVaultCommandContext {
  globalOpts: GlobalOptions;
  ctx: CliContext;
  vault: AsyncVault;
  vaultArg: string;
}

function parseOptionalPubkey(
  value: string | undefined,
  label: string,
): PublicKey | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

async function loadAsyncVaultCommand(
  program: Command,
  vaultArg: string,
  opts: CommonVaultOptions,
  requiresWallet: boolean,
): Promise<AsyncVaultCommandContext> {
  const globalOpts = getGlobalOptions(program);
  const ctx = await createContext(
    globalOpts,
    opts as Record<string, unknown>,
    true,
    requiresWallet,
  );
  const { output, config, provider } = ctx;

  const resolved = resolveVaultArg(vaultArg, config, opts, output);
  if (!resolved) {
    process.exit(1);
  }

  if (resolved.variant !== "svs-10") {
    output.error(
      `This command only supports SVS-10 async vaults. Vault variant: ${resolved.variant}.`,
    );
    process.exit(1);
  }

  const idlPath = findIdlPath(resolved.variant);
  if (!idlPath) {
    output.error("IDL for svs-10 not found. Run `anchor build` first.");
    process.exit(1);
  }

  const idl = loadIdl(idlPath);
  const client = new Program(idl, provider);
  const vault = await AsyncVault.load(client, resolved.assetMint, resolved.vaultId);

  return { globalOpts, ctx, vault, vaultArg };
}

export function registerAsyncCommands(program: Command): void {
  const asyncCmd = program
    .command("async")
    .description("SVS-10 async vault operations");

  asyncCmd
    .command("status")
    .description("Show async vault state and optional user request state")
    .argument("<vault>", "Vault address or alias")
    .option("--owner <pubkey>", "Owner to inspect request state for")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { globalOpts, ctx, vault } = await loadAsyncVaultCommand(
        program,
        vaultArg,
        opts,
        true,
      );
      const { output, wallet } = ctx;

      try {
        const owner = parseOptionalPubkey(opts.owner, "owner") ?? wallet.publicKey;
        const [state, mintedShares, depositRequest, redeemRequest, claimableEscrow] =
          await Promise.all([
            vault.getState(),
            vault.mintedShareSupply(),
            vault.getDepositRequest(owner),
            vault.getRedeemRequest(owner),
            vault.getClaimableEscrow(owner),
          ]);

        if (globalOpts.output === "json") {
          output.json({
            vault: vault.vault.toBase58(),
            authority: state.authority.toBase58(),
            operator: state.operator.toBase58(),
            assetMint: state.assetMint.toBase58(),
            sharesMint: state.sharesMint.toBase58(),
            assetVault: state.assetVault.toBase58(),
            shareEscrow: state.shareEscrow.toBase58(),
            totalAssets: state.totalAssets.toString(),
            totalShares: state.totalShares.toString(),
            mintedShares: mintedShares.toString(),
            pendingDepositAssets: state.pendingDepositAssets.toString(),
            pendingClaimShares: state.pendingClaimShares.toString(),
            paused: state.paused,
            vaultId: state.vaultId.toString(),
            maxStaleness: state.maxStaleness.toString(),
            requestExpirySecs: state.requestExpirySecs.toString(),
            owner: owner.toBase58(),
            depositRequest: depositRequest
              ? {
                  receiver: depositRequest.receiver.toBase58(),
                  assetsLocked: depositRequest.assetsLocked.toString(),
                  sharesClaimable: depositRequest.sharesClaimable.toString(),
                  status: depositRequest.status,
                }
              : null,
            redeemRequest: redeemRequest
              ? {
                  receiver: redeemRequest.receiver.toBase58(),
                  sharesLocked: redeemRequest.sharesLocked.toString(),
                  assetsClaimable: redeemRequest.assetsClaimable.toString(),
                  status: redeemRequest.status,
                }
              : null,
            claimableEscrow: claimableEscrow
              ? {
                  amount: claimableEscrow.amount.toString(),
                }
              : null,
          });
          return;
        }

        output.info(`Async Vault: ${vaultArg}`);
        output.table(
          ["Property", "Value"],
          [
            ["Vault", vault.vault.toBase58()],
            ["Authority", state.authority.toBase58()],
            ["Operator", state.operator.toBase58()],
            ["Asset Mint", state.assetMint.toBase58()],
            ["Shares Mint", state.sharesMint.toBase58()],
            ["Asset Vault", state.assetVault.toBase58()],
            ["Share Escrow", state.shareEscrow.toBase58()],
            ["Total Assets", state.totalAssets.toString()],
            ["Total Shares", state.totalShares.toString()],
            ["Minted Shares", mintedShares.toString()],
            ["Pending Deposit Assets", state.pendingDepositAssets.toString()],
            ["Pending Claim Shares", state.pendingClaimShares.toString()],
            ["Paused", state.paused ? "Yes" : "No"],
            ["Vault ID", state.vaultId.toString()],
            ["Max Staleness", state.maxStaleness.toString()],
            ["Request Expiry", state.requestExpirySecs.toString()],
          ],
        );

        output.info("");
        output.info(`Owner State: ${owner.toBase58()}`);
        output.table(
          ["Request", "Status", "Amount", "Receiver"],
          [
            [
              "Deposit",
              depositRequest?.status ?? "none",
              depositRequest?.assetsLocked.toString() ?? "0",
              depositRequest?.receiver.toBase58() ?? "-",
            ],
            [
              "Deposit Claim",
              depositRequest?.status === "fulfilled" ? "claimable" : "none",
              depositRequest?.status === "fulfilled"
                ? depositRequest.sharesClaimable.toString()
                : "0",
              depositRequest?.receiver.toBase58() ?? "-",
            ],
            [
              "Redeem",
              redeemRequest?.status ?? "none",
              redeemRequest?.sharesLocked.toString() ?? "0",
              redeemRequest?.receiver.toBase58() ?? "-",
            ],
            [
              "Redeem Claim",
              claimableEscrow ? "claimable" : "none",
              claimableEscrow?.amount.toString() ?? "0",
              redeemRequest?.receiver.toBase58() ?? "-",
            ],
          ],
        );
      } catch (error) {
        output.error(
          `Failed to inspect async vault: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("request-deposit")
    .description("Open a pending deposit request")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-a, --amount <number>", "Amount of assets to lock")
    .option("--receiver <pubkey>", "Receiver for the fulfilled shares")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { globalOpts, ctx, vault } = await loadAsyncVaultCommand(
        program,
        vaultArg,
        opts,
        true,
      );
      const { output, wallet, options } = ctx;

      try {
        const amount = new BN(opts.amount);
        const receiver =
          parseOptionalPubkey(opts.receiver, "receiver") ?? wallet.publicKey;

        output.info(`Vault: ${vaultArg}`);
        output.info(`Locking assets: ${amount.toString()}`);
        output.info(`Receiver: ${receiver.toBase58()}`);

        if (options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          if (globalOpts.output === "json") {
            output.json({
              dryRun: true,
              operation: "request-deposit",
              vault: vaultArg,
              assets: amount.toString(),
              receiver: receiver.toBase58(),
            });
          }
          return;
        }

        const signature = await vault.requestDeposit(wallet.publicKey, {
          assets: amount,
          receiver,
        });

        output.success("Deposit request submitted");
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Request deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("cancel-deposit")
    .description("Cancel your pending deposit request")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { ctx, vault } = await loadAsyncVaultCommand(program, vaultArg, opts, true);
      const { output, wallet } = ctx;

      try {
        const signature = await vault.cancelDeposit(wallet.publicKey);
        output.success("Deposit request cancelled");
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Cancel deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("fulfill-deposit")
    .description("Fulfill a user's pending deposit request")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--owner <pubkey>", "Request owner")
    .option("--oracle-account <pubkey>", "Oracle price account")
    .option("--oracle-program <pubkey>", "Oracle program ID")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { ctx, vault } = await loadAsyncVaultCommand(program, vaultArg, opts, true);
      const { output, wallet } = ctx;

      try {
        const owner = parseOptionalPubkey(opts.owner, "owner");
        if (!owner) {
          throw new Error("Owner is required");
        }

        const signature = await vault.fulfillDeposit(wallet.publicKey, {
          owner,
          oracleAccount: parseOptionalPubkey(
            opts.oracleAccount,
            "oracle account",
          ),
          oracleProgram: parseOptionalPubkey(
            opts.oracleProgram,
            "oracle program",
          ),
        });

        output.success("Deposit request fulfilled");
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Fulfill deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("claim-deposit")
    .description("Claim shares from a fulfilled deposit request")
    .argument("<vault>", "Vault address or alias")
    .option("--owner <pubkey>", "Request owner (defaults to wallet)")
    .option("--receiver <pubkey>", "Receiver override (must match request)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { ctx, vault } = await loadAsyncVaultCommand(program, vaultArg, opts, true);
      const { output, wallet } = ctx;

      try {
        const signature = await vault.claimDeposit(wallet.publicKey, {
          owner: parseOptionalPubkey(opts.owner, "owner"),
          receiver: parseOptionalPubkey(opts.receiver, "receiver"),
        });

        output.success("Deposit claim completed");
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Claim deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("request-redeem")
    .description("Open a pending redeem request")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("-s, --shares <number>", "Amount of shares to lock")
    .option("--receiver <pubkey>", "Receiver for the fulfilled assets")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { ctx, vault } = await loadAsyncVaultCommand(program, vaultArg, opts, true);
      const { output, wallet } = ctx;

      try {
        const shares = new BN(opts.shares);
        const receiver =
          parseOptionalPubkey(opts.receiver, "receiver") ?? wallet.publicKey;

        const signature = await vault.requestRedeem(wallet.publicKey, {
          shares,
          receiver,
        });

        output.success("Redeem request submitted");
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Request redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("cancel-redeem")
    .description("Cancel your pending redeem request")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { ctx, vault } = await loadAsyncVaultCommand(program, vaultArg, opts, true);
      const { output, wallet } = ctx;

      try {
        const signature = await vault.cancelRedeem(wallet.publicKey);
        output.success("Redeem request cancelled");
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Cancel redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("fulfill-redeem")
    .description("Fulfill a user's pending redeem request")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--owner <pubkey>", "Request owner")
    .option("--oracle-account <pubkey>", "Oracle price account")
    .option("--oracle-program <pubkey>", "Oracle program ID")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { ctx, vault } = await loadAsyncVaultCommand(program, vaultArg, opts, true);
      const { output, wallet } = ctx;

      try {
        const owner = parseOptionalPubkey(opts.owner, "owner");
        if (!owner) {
          throw new Error("Owner is required");
        }

        const signature = await vault.fulfillRedeem(wallet.publicKey, {
          owner,
          oracleAccount: parseOptionalPubkey(
            opts.oracleAccount,
            "oracle account",
          ),
          oracleProgram: parseOptionalPubkey(
            opts.oracleProgram,
            "oracle program",
          ),
        });

        output.success("Redeem request fulfilled");
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Fulfill redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("claim-redeem")
    .description("Claim assets from a fulfilled redeem request")
    .argument("<vault>", "Vault address or alias")
    .option("--owner <pubkey>", "Request owner (defaults to wallet)")
    .option("--receiver <pubkey>", "Receiver override (must match request)")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { ctx, vault } = await loadAsyncVaultCommand(program, vaultArg, opts, true);
      const { output, wallet } = ctx;

      try {
        const signature = await vault.claimRedeem(wallet.publicKey, {
          owner: parseOptionalPubkey(opts.owner, "owner"),
          receiver: parseOptionalPubkey(opts.receiver, "receiver"),
        });

        output.success("Redeem claim completed");
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Claim redeem failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("set-operator")
    .description("Approve or revoke a delegated claim operator")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--operator <pubkey>", "Operator to approve or revoke")
    .option("--revoke", "Revoke approval instead of approving")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { ctx, vault } = await loadAsyncVaultCommand(program, vaultArg, opts, true);
      const { output, wallet } = ctx;

      try {
        const operator = parseOptionalPubkey(opts.operator, "operator");
        if (!operator) {
          throw new Error("Operator is required");
        }

        const approved = !Boolean(opts.revoke);
        const signature = await vault.setOperatorApproval(
          wallet.publicKey,
          operator,
          approved,
        );

        output.success(
          approved ? "Operator approved for claim delegation" : "Operator revoked",
        );
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Set operator failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  asyncCmd
    .command("set-vault-operator")
    .description("Set the vault-level operator authorized to fulfill requests")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--operator <pubkey>", "New vault operator")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .option("--variant <variant>", "Vault variant override for raw addresses")
    .action(async (vaultArg, opts) => {
      const { ctx, vault } = await loadAsyncVaultCommand(program, vaultArg, opts, true);
      const { output, wallet } = ctx;

      try {
        const operator = parseOptionalPubkey(opts.operator, "operator");
        if (!operator) {
          throw new Error("Operator is required");
        }

        const signature = await vault.setVaultOperator(wallet.publicKey, operator);
        output.success("Vault operator updated");
        output.info(`Signature: ${signature}`);
      } catch (error) {
        output.error(
          `Set vault operator failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
