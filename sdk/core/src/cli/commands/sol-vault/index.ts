/**
 * SVS-7 Native SOL Vault CLI Commands
 *
 * Commands for interacting with native SOL vaults:
 * - sol-vault init       — Initialize a new SOL vault
 * - sol-vault deposit    — Deposit native SOL, receive shares
 * - sol-vault mint       — Mint exact shares by paying SOL
 * - sol-vault withdraw   — Withdraw exact SOL by burning shares
 * - sol-vault redeem     — Redeem shares for SOL
 * - sol-vault info       — Show vault state and balances
 * - sol-vault preview    — Preview an operation without executing
 *
 * @example
 * ```bash
 * # Initialize a new SOL vault (vault ID 1)
 * solana-vault sol-vault init --vault-id 1
 *
 * # Deposit 1 SOL with 1% slippage
 * solana-vault sol-vault deposit --vault-id 1 --lamports 1000000000 --slippage 100
 *
 * # Preview redeem
 * solana-vault sol-vault preview redeem --vault-id 1 --shares 500000000
 * ```
 */

import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SolVault } from "../../../sol-vault";
import { findIdlPath, loadIdl } from "../../utils";

export function registerSolVaultCommands(program: Command): void {
  const solVaultCmd = program
    .command("sol-vault")
    .description("Manage SVS-7 native SOL vaults");

  registerSolVaultInitCommand(solVaultCmd);
  registerSolVaultDepositCommand(solVaultCmd);
  registerSolVaultMintCommand(solVaultCmd);
  registerSolVaultWithdrawCommand(solVaultCmd);
  registerSolVaultRedeemCommand(solVaultCmd);
  registerSolVaultInfoCommand(solVaultCmd);
  registerSolVaultPreviewCommand(solVaultCmd);
}

// ============ Helpers ============

function getVaultIdOption(opts: { vaultId: string }): BN {
  return new BN(opts.vaultId);
}

async function loadSolVault(
  program: Program,
  vaultId: BN,
  output: { error: (msg: string) => void },
): Promise<SolVault | null> {
  try {
    return await SolVault.load(program, vaultId);
  } catch (e) {
    output.error(
      `Failed to load SOL vault ${vaultId.toString()}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

// ============ init ============

function registerSolVaultInitCommand(parent: Command): void {
  parent
    .command("init")
    .description("Initialize a new native SOL vault")
    .requiredOption("--vault-id <number>", "Unique vault ID (u64)")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider } = ctx;

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      const vaultId = getVaultIdOption(opts);

      if (!ctx.options.yes) {
        const confirmed = await output.confirm(
          `Initialize SOL vault with ID ${vaultId.toString()}?`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);

        const spinner = output.spinner("Initializing SOL vault...");
        spinner.start();

        const vault = await SolVault.create(prog, { vaultId });

        spinner.succeed("SOL vault initialized");
        output.success(`Vault address: ${vault.vault.toBase58()}`);
        output.success(`Shares mint:   ${vault.sharesMint.toBase58()}`);
        output.success(`wSOL vault:    ${vault.wsolVault.toBase58()}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            vaultId: vaultId.toString(),
            vault: vault.vault.toBase58(),
            sharesMint: vault.sharesMint.toBase58(),
            wsolVault: vault.wsolVault.toBase58(),
          });
        }
      } catch (e) {
        output.error(
          `Init failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exit(1);
      }
    });
}

// ============ deposit ============

function registerSolVaultDepositCommand(parent: Command): void {
  parent
    .command("deposit")
    .description("Deposit native SOL and receive vault shares")
    .requiredOption("--vault-id <number>", "Vault ID")
    .requiredOption("-l, --lamports <number>", "Lamports to deposit")
    .option("-s, --slippage <bps>", "Max slippage in basis points", "50")
    .option("--min-shares <number>", "Minimum shares (overrides slippage)")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      const vaultId = getVaultIdOption(opts);
      const lamports = new BN(opts.lamports);
      const slippageBps = parseInt(opts.slippage);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await loadSolVault(prog, vaultId, output);
        if (!vault) process.exit(1);

        const previewShares = await vault.previewDepositSol(lamports);
        const minShares = opts.minShares
          ? new BN(opts.minShares)
          : previewShares.muln(10000 - slippageBps).divn(10000);

        output.info(`Vault ID:        ${vaultId.toString()}`);
        output.info(`Depositing:      ${lamports.toString()} lamports`);
        output.info(`Expected shares: ${previewShares.toString()}`);
        output.info(
          `Min shares (${slippageBps}bps): ${minShares.toString()}`,
        );

        if (ctx.options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!ctx.options.yes) {
          const confirmed = await output.confirm("Proceed with deposit?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.depositSol(wallet.publicKey, {
          lamports,
          minSharesOut: minShares,
        });

        spinner.succeed("Transaction confirmed");
        output.success(`Deposited ${lamports.toString()} lamports`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            lamports: lamports.toString(),
            expectedShares: previewShares.toString(),
          });
        }
      } catch (e) {
        output.error(
          `Deposit failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exit(1);
      }
    });
}

// ============ mint ============

function registerSolVaultMintCommand(parent: Command): void {
  parent
    .command("mint")
    .description("Mint exact vault shares by paying native SOL")
    .requiredOption("--vault-id <number>", "Vault ID")
    .requiredOption("--shares <number>", "Exact shares to mint")
    .option("-s, --slippage <bps>", "Max slippage in basis points", "50")
    .option("--max-lamports <number>", "Maximum lamports to pay (overrides slippage)")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      const vaultId = getVaultIdOption(opts);
      const shares = new BN(opts.shares);
      const slippageBps = parseInt(opts.slippage);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await loadSolVault(prog, vaultId, output);
        if (!vault) process.exit(1);

        const previewLamports = await vault.previewMintSol(shares);
        const maxLamports = opts.maxLamports
          ? new BN(opts.maxLamports)
          : previewLamports.muln(10000 + slippageBps).divn(10000);

        output.info(`Vault ID:        ${vaultId.toString()}`);
        output.info(`Minting shares:  ${shares.toString()}`);
        output.info(`Expected cost:   ${previewLamports.toString()} lamports`);
        output.info(
          `Max lamports (${slippageBps}bps): ${maxLamports.toString()}`,
        );

        if (ctx.options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!ctx.options.yes) {
          const confirmed = await output.confirm("Proceed with mint?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.mintSol(wallet.publicKey, {
          shares,
          maxLamportsIn: maxLamports,
        });

        spinner.succeed("Transaction confirmed");
        output.success(`Minted ${shares.toString()} shares`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            shares: shares.toString(),
            expectedLamports: previewLamports.toString(),
          });
        }
      } catch (e) {
        output.error(
          `Mint failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exit(1);
      }
    });
}

// ============ withdraw ============

function registerSolVaultWithdrawCommand(parent: Command): void {
  parent
    .command("withdraw")
    .description("Withdraw exact native SOL by burning vault shares")
    .requiredOption("--vault-id <number>", "Vault ID")
    .requiredOption("-l, --lamports <number>", "Exact lamports to withdraw")
    .option("-s, --slippage <bps>", "Max slippage in basis points", "50")
    .option("--max-shares <number>", "Maximum shares to burn (overrides slippage)")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      const vaultId = getVaultIdOption(opts);
      const lamports = new BN(opts.lamports);
      const slippageBps = parseInt(opts.slippage);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await loadSolVault(prog, vaultId, output);
        if (!vault) process.exit(1);

        const previewShares = await vault.previewWithdrawSol(lamports);
        const maxShares = opts.maxShares
          ? new BN(opts.maxShares)
          : previewShares.muln(10000 + slippageBps).divn(10000);

        output.info(`Vault ID:          ${vaultId.toString()}`);
        output.info(`Withdrawing:       ${lamports.toString()} lamports`);
        output.info(`Expected shares:   ${previewShares.toString()}`);
        output.info(
          `Max shares (${slippageBps}bps): ${maxShares.toString()}`,
        );

        if (ctx.options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!ctx.options.yes) {
          const confirmed = await output.confirm("Proceed with withdraw?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.withdrawSol(wallet.publicKey, {
          lamports,
          maxSharesIn: maxShares,
        });

        spinner.succeed("Transaction confirmed");
        output.success(`Withdrew ${lamports.toString()} lamports`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            lamports: lamports.toString(),
            expectedShares: previewShares.toString(),
          });
        }
      } catch (e) {
        output.error(
          `Withdraw failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exit(1);
      }
    });
}

// ============ redeem ============

function registerSolVaultRedeemCommand(parent: Command): void {
  parent
    .command("redeem")
    .description("Redeem vault shares for native SOL")
    .requiredOption("--vault-id <number>", "Vault ID")
    .requiredOption("--shares <number>", "Exact shares to redeem")
    .option("-s, --slippage <bps>", "Max slippage in basis points", "50")
    .option("--min-lamports <number>", "Minimum lamports (overrides slippage)")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      const vaultId = getVaultIdOption(opts);
      const shares = new BN(opts.shares);
      const slippageBps = parseInt(opts.slippage);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await loadSolVault(prog, vaultId, output);
        if (!vault) process.exit(1);

        const previewLamports = await vault.previewRedeemSol(shares);
        const minLamports = opts.minLamports
          ? new BN(opts.minLamports)
          : previewLamports.muln(10000 - slippageBps).divn(10000);

        output.info(`Vault ID:          ${vaultId.toString()}`);
        output.info(`Redeeming shares:  ${shares.toString()}`);
        output.info(
          `Expected lamports: ${previewLamports.toString()}`,
        );
        output.info(
          `Min lamports (${slippageBps}bps): ${minLamports.toString()}`,
        );

        if (ctx.options.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!ctx.options.yes) {
          const confirmed = await output.confirm("Proceed with redeem?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Sending transaction...");
        spinner.start();

        const signature = await vault.redeemSol(wallet.publicKey, {
          shares,
          minLamportsOut: minLamports,
        });

        spinner.succeed("Transaction confirmed");
        output.success(`Redeemed ${shares.toString()} shares`);
        output.info(`Signature: ${signature}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            signature,
            shares: shares.toString(),
            expectedLamports: previewLamports.toString(),
          });
        }
      } catch (e) {
        output.error(
          `Redeem failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exit(1);
      }
    });
}

// ============ info ============

function registerSolVaultInfoCommand(parent: Command): void {
  parent
    .command("info")
    .description("Show SVS-7 vault state and balances")
    .requiredOption("--vault-id <number>", "Vault ID")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, provider } = ctx;

      const idlPath = findIdlPath();
      if (!idlPath) {
        output.error("IDL not found. Run `anchor build` first.");
        process.exit(1);
      }

      const vaultId = getVaultIdOption(opts);

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const vault = await loadSolVault(prog, vaultId, output);
        if (!vault) process.exit(1);

        const [state, totalAssets, totalSharesSupply] = await Promise.all([
          vault.getState(),
          vault.totalAssets(),
          vault.totalShares(),
        ]);

        output.info(`=== SOL Vault ${vaultId.toString()} ===`);
        output.info(`Vault address:   ${vault.vault.toBase58()}`);
        output.info(`Authority:       ${state.authority.toBase58()}`);
        output.info(`Shares mint:     ${vault.sharesMint.toBase58()}`);
        output.info(`wSOL vault:      ${vault.wsolVault.toBase58()}`);
        output.info(`Total assets:    ${totalAssets.toString()} lamports`);
        output.info(`Total shares:    ${totalSharesSupply.toString()}`);
        output.info(`Decimals offset: ${state.decimalsOffset}`);
        output.info(`Paused:          ${state.paused}`);

        if (globalOpts.output === "json") {
          output.json({
            vaultId: vaultId.toString(),
            vault: vault.vault.toBase58(),
            authority: state.authority.toBase58(),
            sharesMint: vault.sharesMint.toBase58(),
            wsolVault: vault.wsolVault.toBase58(),
            totalAssets: totalAssets.toString(),
            totalShares: totalSharesSupply.toString(),
            decimalsOffset: state.decimalsOffset,
            paused: state.paused,
          });
        }
      } catch (e) {
        output.error(
          `Info failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exit(1);
      }
    });
}

// ============ preview ============

function registerSolVaultPreviewCommand(parent: Command): void {
  const previewCmd = parent
    .command("preview")
    .description("Preview a SOL vault operation without executing");

  ["deposit", "mint", "withdraw", "redeem"].forEach((op) => {
    previewCmd
      .command(op)
      .description(`Preview ${op} operation`)
      .requiredOption("--vault-id <number>", "Vault ID")
      .option("-l, --lamports <number>", "Lamports (for deposit/withdraw)")
      .option("--shares <number>", "Shares (for mint/redeem)")
      .action(async (opts) => {
        const globalOpts = getGlobalOptions(parent.parent!);
        const ctx = await createContext(globalOpts, opts, true, false);
        const { output, provider } = ctx;

        const idlPath = findIdlPath();
        if (!idlPath) {
          output.error("IDL not found. Run `anchor build` first.");
          process.exit(1);
        }

        const vaultId = getVaultIdOption(opts);

        try {
          const idl = loadIdl(idlPath);
          const prog = new Program(idl as any, provider);
          const vault = await loadSolVault(prog, vaultId, output);
          if (!vault) process.exit(1);

          let result: BN;
          let inputLabel: string;
          let inputValue: string;
          let outputLabel: string;

          if (op === "deposit") {
            const lamports = new BN(opts.lamports || "0");
            result = await vault.previewDepositSol(lamports);
            inputLabel = "Lamports in";
            inputValue = lamports.toString();
            outputLabel = "Shares out";
          } else if (op === "mint") {
            const shares = new BN(opts.shares || "0");
            result = await vault.previewMintSol(shares);
            inputLabel = "Shares out";
            inputValue = shares.toString();
            outputLabel = "Lamports in";
          } else if (op === "withdraw") {
            const lamports = new BN(opts.lamports || "0");
            result = await vault.previewWithdrawSol(lamports);
            inputLabel = "Lamports out";
            inputValue = lamports.toString();
            outputLabel = "Shares in";
          } else {
            const shares = new BN(opts.shares || "0");
            result = await vault.previewRedeemSol(shares);
            inputLabel = "Shares in";
            inputValue = shares.toString();
            outputLabel = "Lamports out";
          }

          output.info(
            `Preview ${op}: ${inputLabel}=${inputValue} → ${outputLabel}=${result.toString()}`,
          );

          if (globalOpts.output === "json") {
            output.json({
              operation: op,
              [inputLabel.toLowerCase().replace(/ /g, "_")]: inputValue,
              [outputLabel.toLowerCase().replace(/ /g, "_")]: result.toString(),
            });
          }
        } catch (e) {
          output.error(
            `Preview failed: ${e instanceof Error ? e.message : String(e)}`,
          );
          process.exit(1);
        }
      });
  });
}
