/**
 * Credit Vault Commands (SVS-11)
 *
 * CLI commands for credit markets vault lifecycle:
 * request-deposit, cancel-deposit, approve-deposit, reject-deposit,
 * request-redeem, cancel-redeem, approve-redeem, claim,
 * repay, window open/close, freeze/unfreeze,
 * admin (pause, unpause, transfer-authority, set-manager, update-attester),
 * show (view)
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
import { CreditVault } from "../../../credit-vault";
import {
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableEscrowAddress,
  getFrozenAccountAddress,
} from "../../../credit-pda";

async function loadCreditVault(
  program: Command,
  vaultArg: string,
  opts: Record<string, unknown>,
): Promise<{
  vault: CreditVault;
  ctx: Awaited<ReturnType<typeof createContext>>;
}> {
  const globalOpts = getGlobalOptions(program);
  const ctx = await createContext(globalOpts, opts, true, true);
  const { output, config, provider } = ctx;

  const vaultOpts: {
    programId?: string;
    assetMint?: string;
    vaultId?: string;
  } = {
    programId: opts.programId as string | undefined,
    assetMint: opts.assetMint as string | undefined,
    vaultId: opts.vaultId as string | undefined,
  };
  const resolved = resolveVaultArg(vaultArg, config, vaultOpts, output);
  if (!resolved) process.exit(1);

  resolved.variant = "svs-11";

  const idlPath = findIdlPath("svs-11");
  if (!idlPath) {
    output.error("SVS-11 IDL not found. Run `anchor build -p svs-11` first.");
    process.exit(1);
  }

  const idl = loadIdl(idlPath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IDL loaded from JSON
  const prog = new Program(idl as any, provider);
  const vault = await CreditVault.load(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic IDL → typed Program bridge
    prog as any,
    resolved.assetMint,
    resolved.vaultId,
  );

  return { vault, ctx };
}

/** Common vault options added to all subcommands */
function addVaultOptions(cmd: Command): Command {
  return cmd
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1");
}

export function registerCreditVaultCommands(program: Command): void {
  const credit = program
    .command("credit")
    .description("Credit vault operations (SVS-11 credit markets)");

  // ============================================================================
  // View
  // ============================================================================

  addVaultOptions(
    credit
      .command("show")
      .description("Show credit vault state and pending requests")
      .argument("<vault>", "Vault address or alias")
      .option("--investor <pubkey>", "Investor to check (defaults to wallet)"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet } = ctx;
    const globalOpts = getGlobalOptions(program);
    const investor = opts.investor
      ? new PublicKey(opts.investor as string)
      : wallet.publicKey;

    try {
      const state = vault.state;
      const frozen = await vault.isFrozen(investor);
      const investReq = await vault.getInvestmentRequest(investor);
      const redeemReq = await vault.getRedemptionRequest(investor);
      const claimable = await vault.getClaimableEscrow(investor);

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          investor: investor.toBase58(),
          state: {
            authority: state.authority.toBase58(),
            manager: state.manager.toBase58(),
            totalAssets: state.totalAssets.toString(),
            totalShares: state.totalShares.toString(),
            paused: state.paused,
            windowOpen: state.investmentWindowOpen,
            minimumInvestment: state.minimumInvestment.toString(),
          },
          frozen,
          investmentRequest: investReq,
          redemptionRequest: redeemReq,
          claimableEscrow: claimable,
        });
        return;
      }

      output.info(`Credit Vault: ${vaultArg}`);
      output.table(
        ["Property", "Value"],
        [
          ["Authority", state.authority.toBase58()],
          ["Manager", state.manager.toBase58()],
          ["Total Assets", formatNumber(state.totalAssets)],
          ["Total Shares", formatNumber(state.totalShares)],
          ["Paused", state.paused ? "Yes" : "No"],
          ["Window Open", state.investmentWindowOpen ? "Yes" : "No"],
          ["Min Investment", formatNumber(state.minimumInvestment)],
        ],
      );

      output.info(`\nInvestor: ${investor.toBase58()}`);
      output.info(`Frozen: ${frozen ? "Yes" : "No"}`);
      output.info(`Investment Request: ${investReq ? "Active" : "None"}`);
      output.info(`Redemption Request: ${redeemReq ? "Active" : "None"}`);
      output.info(`Claimable: ${claimable ? "Yes" : "No"}`);
    } catch (error) {
      output.error(
        `Failed to fetch vault state: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  // ============================================================================
  // Investor Commands
  // ============================================================================

  addVaultOptions(
    credit
      .command("request-deposit")
      .description("Request a deposit into a credit vault")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("-a, --amount <number>", "Amount of assets to deposit")
      .requiredOption(
        "--attestation <pubkey>",
        "KYC attestation account address",
      ),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    const amount = new BN(opts.amount as string);
    const attestation = new PublicKey(opts.attestation as string);

    output.info(`Requesting deposit: ${formatNumber(amount)} assets`);

    if (options.dryRun) {
      output.success("Dry run complete. No transaction sent.");
      return;
    }

    if (!options.yes) {
      const confirmed = await output.confirm("Proceed with deposit request?");
      if (!confirmed) {
        output.warn("Aborted.");
        return;
      }
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.requestDeposit(wallet, amount, attestation);
      spinner.succeed("Deposit request submitted");
      output.success(`Signature: ${sig}`);
      output.info("Manager must approve this request.");
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          amount: amount.toString(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Request deposit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    credit
      .command("cancel-deposit")
      .description("Cancel a pending deposit request")
      .argument("<vault>", "Vault address or alias"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    if (options.dryRun) {
      output.success("Dry run complete.");
      return;
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.cancelDeposit(wallet);
      spinner.succeed("Deposit request cancelled");
      output.success(`Assets returned. Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({ success: true, signature: sig });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Cancel deposit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    credit
      .command("request-redeem")
      .description("Request redemption of shares")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("-s, --shares <number>", "Amount of shares to redeem")
      .requiredOption(
        "--attestation <pubkey>",
        "KYC attestation account address",
      ),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    const shares = new BN(opts.shares as string);
    const attestation = new PublicKey(opts.attestation as string);

    output.info(`Requesting redeem: ${formatNumber(shares)} shares`);

    if (options.dryRun) {
      output.success("Dry run complete.");
      return;
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.requestRedeem(wallet, shares, attestation);
      spinner.succeed("Redeem request submitted");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          shares: shares.toString(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Request redeem failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    credit
      .command("cancel-redeem")
      .description("Cancel a pending redeem request")
      .argument("<vault>", "Vault address or alias"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    if (options.dryRun) {
      output.success("Dry run complete.");
      return;
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.cancelRedeem(wallet);
      spinner.succeed("Redeem request cancelled");
      output.success(`Shares returned. Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({ success: true, signature: sig });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Cancel redeem failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    credit
      .command("claim")
      .description("Claim assets from an approved redemption")
      .argument("<vault>", "Vault address or alias"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    if (options.dryRun) {
      output.success("Dry run complete.");
      return;
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.claimRedemption(wallet);
      spinner.succeed("Redemption claimed");
      output.success(`Assets transferred. Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({ success: true, signature: sig });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Claim failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  // ============================================================================
  // Manager Commands
  // ============================================================================

  addVaultOptions(
    credit
      .command("approve-deposit")
      .description("Approve a pending deposit request (manager only)")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("--investor <pubkey>", "Investor address")
      .requiredOption("--oracle <pubkey>", "Oracle price account")
      .requiredOption("--attestation <pubkey>", "Attestation account"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    const investor = new PublicKey(opts.investor as string);
    const oracle = new PublicKey(opts.oracle as string);
    const attestation = new PublicKey(opts.attestation as string);

    output.info(`Approving deposit for: ${investor.toBase58()}`);

    if (options.dryRun) {
      output.success("Dry run complete.");
      return;
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.approveDeposit(
        wallet,
        investor,
        oracle,
        attestation,
      );
      spinner.succeed("Deposit approved — shares minted to investor");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          investor: investor.toBase58(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Approve deposit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    credit
      .command("reject-deposit")
      .description("Reject a pending deposit request (manager only)")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("--investor <pubkey>", "Investor address")
      .option("--reason <number>", "Reason code (0-255)", "0"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    const investor = new PublicKey(opts.investor as string);
    const reasonCode = parseInt(opts.reason as string, 10);

    output.info(`Rejecting deposit for: ${investor.toBase58()}`);

    if (options.dryRun) {
      output.success("Dry run complete.");
      return;
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.rejectDeposit(wallet, investor, reasonCode);
      spinner.succeed("Deposit rejected — assets returned to investor");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          investor: investor.toBase58(),
          reasonCode,
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Reject deposit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    credit
      .command("approve-redeem")
      .description("Approve a pending redeem request (manager only)")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("--investor <pubkey>", "Investor address")
      .requiredOption("--oracle <pubkey>", "Oracle price account"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    const investor = new PublicKey(opts.investor as string);
    const oracle = new PublicKey(opts.oracle as string);

    output.info(`Approving redeem for: ${investor.toBase58()}`);

    if (options.dryRun) {
      output.success("Dry run complete.");
      return;
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.approveRedeem(wallet, investor, oracle);
      spinner.succeed("Redeem approved — assets ready for claim");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          investor: investor.toBase58(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Approve redeem failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    credit
      .command("repay")
      .description("Repay assets to the vault (manager only)")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("-a, --amount <number>", "Amount to repay"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    const amount = new BN(opts.amount as string);

    output.info(`Repaying ${formatNumber(amount)} assets to vault`);

    if (options.dryRun) {
      output.success("Dry run complete.");
      return;
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.repay(wallet, amount);
      spinner.succeed("Repayment complete");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          amount: amount.toString(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Repay failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  // ============================================================================
  // Window Commands
  // ============================================================================

  const window = credit
    .command("window")
    .description("Manage investment window (manager only)");

  addVaultOptions(
    window
      .command("open")
      .description("Open the investment window")
      .argument("<vault>", "Vault address or alias"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet } = ctx;
    const globalOpts = getGlobalOptions(program);

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.openWindow(wallet);
      spinner.succeed("Investment window opened");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({ success: true, signature: sig });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Open window failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    window
      .command("close")
      .description("Close the investment window")
      .argument("<vault>", "Vault address or alias"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet } = ctx;
    const globalOpts = getGlobalOptions(program);

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.closeWindow(wallet);
      spinner.succeed("Investment window closed");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({ success: true, signature: sig });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Close window failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  // ============================================================================
  // Compliance Commands
  // ============================================================================

  addVaultOptions(
    credit
      .command("freeze")
      .description("Freeze an investor account (manager only)")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("--investor <pubkey>", "Investor to freeze"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    const investor = new PublicKey(opts.investor as string);

    if (!options.yes) {
      const confirmed = await output.confirm(
        `Freeze account ${investor.toBase58()}?`,
      );
      if (!confirmed) {
        output.warn("Aborted.");
        return;
      }
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.freezeAccount(wallet, investor);
      spinner.succeed("Account frozen");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          investor: investor.toBase58(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Freeze failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    credit
      .command("unfreeze")
      .description("Unfreeze an investor account (manager only)")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("--investor <pubkey>", "Investor to unfreeze"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet } = ctx;
    const globalOpts = getGlobalOptions(program);

    const investor = new PublicKey(opts.investor as string);

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.unfreezeAccount(wallet, investor);
      spinner.succeed("Account unfrozen");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          investor: investor.toBase58(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Unfreeze failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  // ============================================================================
  // Admin Commands
  // ============================================================================

  const admin = credit
    .command("admin")
    .description("Admin operations (authority only)");

  addVaultOptions(
    admin
      .command("pause")
      .description("Pause the credit vault")
      .argument("<vault>", "Vault address or alias"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet } = ctx;
    const globalOpts = getGlobalOptions(program);

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.pause(wallet);
      spinner.succeed("Vault paused");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({ success: true, signature: sig });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Pause failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    admin
      .command("unpause")
      .description("Unpause the credit vault")
      .argument("<vault>", "Vault address or alias"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet } = ctx;
    const globalOpts = getGlobalOptions(program);

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.unpause(wallet);
      spinner.succeed("Vault unpaused");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({ success: true, signature: sig });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Unpause failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    admin
      .command("transfer-authority")
      .description("Transfer vault authority")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("--new-authority <pubkey>", "New authority address"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet, options } = ctx;
    const globalOpts = getGlobalOptions(program);

    const newAuthority = new PublicKey(opts.newAuthority as string);

    if (!options.yes) {
      const confirmed = await output.confirm(
        `Transfer authority to ${newAuthority.toBase58()}? This cannot be undone.`,
      );
      if (!confirmed) {
        output.warn("Aborted.");
        return;
      }
    }

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.transferAuthority(wallet, newAuthority);
      spinner.succeed("Authority transferred");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          newAuthority: newAuthority.toBase58(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Transfer authority failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    admin
      .command("set-manager")
      .description("Set a new vault manager")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("--new-manager <pubkey>", "New manager address"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet } = ctx;
    const globalOpts = getGlobalOptions(program);

    const newManager = new PublicKey(opts.newManager as string);

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.setManager(wallet, newManager);
      spinner.succeed("Manager updated");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          newManager: newManager.toBase58(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Set manager failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

  addVaultOptions(
    admin
      .command("update-attester")
      .description("Update the KYC attester")
      .argument("<vault>", "Vault address or alias")
      .requiredOption("--new-attester <pubkey>", "New attester address"),
  ).action(async (vaultArg: string, opts: Record<string, unknown>) => {
    const { vault, ctx } = await loadCreditVault(program, vaultArg, opts);
    const { output, wallet } = ctx;
    const globalOpts = getGlobalOptions(program);

    const newAttester = new PublicKey(opts.newAttester as string);

    const spinner = output.spinner("Sending transaction...");
    try {
      spinner.start();
      const sig = await vault.updateAttester(wallet, newAttester);
      spinner.succeed("Attester updated");
      output.success(`Signature: ${sig}`);
      if (globalOpts.output === "json") {
        output.json({
          success: true,
          signature: sig,
          newAttester: newAttester.toBase58(),
        });
      }
    } catch (error) {
      spinner.fail("Transaction failed");
      output.error(
        `Update attester failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });
}
