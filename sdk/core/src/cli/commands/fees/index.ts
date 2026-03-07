/**
 * Fee Commands - View and manage vault fee configuration
 *
 * Commands:
 * - init: Initialize on-chain FeeConfig PDA (requires modules feature)
 * - show: Display fee configuration (reads on-chain if available)
 * - update: Update on-chain fee configuration
 * - configure: [DEPRECATED] Local config only, use `init` for on-chain
 * - preview: Preview fee collection amounts (client-side calculation)
 * - clear: Clear local fee configuration
 */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import {
  resolveVaultArg,
  saveConfig,
  isValidPublicKey,
  findIdlPath,
  loadIdl,
} from "../../utils";
import {
  FeeConfig,
  calculateAccruedFees,
  validateFeeConfig,
  createInitialFeeState,
} from "../../../fees";
import {
  getFeeConfigAddress,
  FeeConfigAccount,
  deriveModuleAddresses,
} from "../../../modules";
import { getVaultAddress } from "../../../pda";

const MAX_BPS = 10000;

/**
 * Fetch on-chain FeeConfig account if it exists
 */
async function fetchOnChainFeeConfig(
  connection: { getAccountInfo: (pubkey: PublicKey) => Promise<unknown> },
  programId: PublicKey,
  vault: PublicKey,
): Promise<FeeConfigAccount | null> {
  const [feeConfigPda] = getFeeConfigAddress(programId, vault);
  const accountInfo = await connection.getAccountInfo(feeConfigPda);
  if (!accountInfo) return null;

  // Account exists - in real implementation we'd deserialize
  // For now, return PDA address for display
  return null; // TODO: Deserialize when IDL available with modules
}

export function registerFeesCommands(program: Command): void {
  const fees = program
    .command("fees")
    .description("View and manage vault fee configuration");

  // ==========================================================================
  // On-chain Module Commands (new)
  // ==========================================================================

  fees
    .command("init")
    .description(
      "Initialize on-chain fee configuration (requires modules feature)",
    )
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--recipient <pubkey>", "Fee recipient address")
    .option("--entry <bps>", "Entry fee in basis points (0-1000)", "0")
    .option("--exit <bps>", "Exit fee in basis points (0-1000)", "0")
    .option("--management <bps>", "Management fee in basis points (0-500)", "0")
    .option(
      "--performance <bps>",
      "Performance fee in basis points (0-3000)",
      "0",
    )
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, config, connection, wallet, provider } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      // Validate bps values
      const entryFeeBps = parseInt(opts.entry);
      const exitFeeBps = parseInt(opts.exit);
      const managementFeeBps = parseInt(opts.management);
      const performanceFeeBps = parseInt(opts.performance);

      if (entryFeeBps < 0 || entryFeeBps > 1000) {
        output.error("Entry fee must be 0-1000 bps (max 10%)");
        process.exit(1);
      }
      if (exitFeeBps < 0 || exitFeeBps > 1000) {
        output.error("Exit fee must be 0-1000 bps (max 10%)");
        process.exit(1);
      }
      if (managementFeeBps < 0 || managementFeeBps > 500) {
        output.error("Management fee must be 0-500 bps (max 5%)");
        process.exit(1);
      }
      if (performanceFeeBps < 0 || performanceFeeBps > 3000) {
        output.error("Performance fee must be 0-3000 bps (max 30%)");
        process.exit(1);
      }

      if (!isValidPublicKey(opts.recipient)) {
        output.error("Invalid fee recipient address");
        process.exit(1);
      }
      const feeRecipient = new PublicKey(opts.recipient);

      // Derive vault PDA
      const [vaultPda] = getVaultAddress(
        resolved.programId,
        resolved.assetMint,
        resolved.vaultId,
      );

      // Derive fee config PDA
      const [feeConfigPda] = getFeeConfigAddress(resolved.programId, vaultPda);

      output.info(`Initializing on-chain fee configuration...`);
      output.info(`  Vault: ${vaultPda.toBase58()}`);
      output.info(`  FeeConfig PDA: ${feeConfigPda.toBase58()}`);
      output.info(`  Entry fee: ${entryFeeBps} bps`);
      output.info(`  Exit fee: ${exitFeeBps} bps`);
      output.info(`  Management fee: ${managementFeeBps} bps`);
      output.info(`  Performance fee: ${performanceFeeBps} bps`);
      output.info(`  Recipient: ${feeRecipient.toBase58()}`);
      output.info("");

      // Load IDL and create program
      const idlPath = findIdlPath(resolved.variant);
      if (!idlPath) {
        output.error(
          `IDL not found for ${resolved.variant}. Run \`anchor build\` first.`,
        );
        process.exit(1);
      }

      // Check if modules feature is available in IDL
      const idl = loadIdl(idlPath) as {
        instructions?: Array<{ name: string }>;
      };
      const hasModules = idl.instructions?.some(
        (ix) => ix.name === "initializeFeeConfig",
      );

      if (!hasModules) {
        output.error(
          `Program was not built with modules feature. Rebuild with:\n` +
            `  anchor build -- --features modules`,
        );
        process.exit(1);
      }

      if (globalOpts.dryRun) {
        output.info("[DRY RUN] Would initialize fee config on-chain");
        output.success("Dry run complete");
        return;
      }

      output.warn(
        "On-chain fee initialization requires program built with modules feature.",
      );
      output.info(
        "Transaction building will be available when IDL includes module instructions.",
      );

      // TODO: Build and send transaction when IDL is available
      // const program = new Program(idl, resolved.programId, provider);
      // await program.methods
      //   .initializeFeeConfig(feeRecipient, entryFeeBps, exitFeeBps, managementFeeBps, performanceFeeBps)
      //   .accounts({ vault: vaultPda, feeConfig: feeConfigPda, authority: wallet.publicKey, ... })
      //   .rpc();

      output.success("Fee config PDA ready for initialization");
    });

  fees
    .command("status")
    .description("Check if on-chain fee module is configured for a vault")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, connection } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      // Derive vault PDA
      const [vaultPda] = getVaultAddress(
        resolved.programId,
        resolved.assetMint,
        resolved.vaultId,
      );

      // Check all module PDAs
      const modules = deriveModuleAddresses(resolved.programId, vaultPda);
      const accountInfos = await connection.getMultipleAccountsInfo([
        modules.feeConfig,
        modules.capConfig,
        modules.lockConfig,
        modules.accessConfig,
      ]);

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultPda.toBase58(),
          modules: {
            feeConfig: {
              address: modules.feeConfig.toBase58(),
              exists: accountInfos[0] !== null,
            },
            capConfig: {
              address: modules.capConfig.toBase58(),
              exists: accountInfos[1] !== null,
            },
            lockConfig: {
              address: modules.lockConfig.toBase58(),
              exists: accountInfos[2] !== null,
            },
            accessConfig: {
              address: modules.accessConfig.toBase58(),
              exists: accountInfos[3] !== null,
            },
          },
        });
        return;
      }

      output.info(`Module Status for ${vaultArg}\n`);
      output.info(`Vault: ${vaultPda.toBase58()}\n`);

      const rows: [string, string, string][] = [
        [
          "Fee Config",
          modules.feeConfig.toBase58(),
          accountInfos[0] ? "Active" : "Not initialized",
        ],
        [
          "Cap Config",
          modules.capConfig.toBase58(),
          accountInfos[1] ? "Active" : "Not initialized",
        ],
        [
          "Lock Config",
          modules.lockConfig.toBase58(),
          accountInfos[2] ? "Active" : "Not initialized",
        ],
        [
          "Access Config",
          modules.accessConfig.toBase58(),
          accountInfos[3] ? "Active" : "Not initialized",
        ],
      ];

      output.table(["Module", "PDA Address", "Status"], rows);
    });

  // ==========================================================================
  // Legacy Local Config Commands (deprecated for enforcement)
  // ==========================================================================

  fees
    .command("show")
    .description("Display current fee configuration and accrued fees")
    .argument("<vault>", "Vault address or alias")
    .option("--program-id <pubkey>", "Program ID (if vault not in config)")
    .option("--asset-mint <pubkey>", "Asset mint (if vault not in config)")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      // Get fee config from local config (fees are managed off-chain in config)
      const storedFees = config.fees?.[vaultArg] as
        | {
            managementFeeBps: number;
            performanceFeeBps: number;
            entryFeeBps?: number;
            exitFeeBps?: number;
            feeRecipient?: string;
          }
        | undefined;

      if (!storedFees) {
        output.info(`No fee configuration for ${vaultArg}`);
        output.info("");
        output.info("Configure fees with:");
        output.info(
          `  solana-vault fees configure ${vaultArg} --management 200 --performance 2000`,
        );
        return;
      }

      if (globalOpts.output === "json") {
        output.json({ vault: vaultArg, fees: storedFees });
        return;
      }

      output.info(`Fee Configuration for ${vaultArg}\n`);

      const rows: [string, string][] = [
        [
          "Management Fee",
          `${storedFees.managementFeeBps} bps (${(storedFees.managementFeeBps / 100).toFixed(2)}%)`,
        ],
        [
          "Performance Fee",
          `${storedFees.performanceFeeBps} bps (${(storedFees.performanceFeeBps / 100).toFixed(2)}%)`,
        ],
      ];

      if (storedFees.entryFeeBps !== undefined) {
        rows.push([
          "Entry Fee",
          `${storedFees.entryFeeBps} bps (${(storedFees.entryFeeBps / 100).toFixed(2)}%)`,
        ]);
      }
      if (storedFees.exitFeeBps !== undefined) {
        rows.push([
          "Exit Fee",
          `${storedFees.exitFeeBps} bps (${(storedFees.exitFeeBps / 100).toFixed(2)}%)`,
        ]);
      }
      if (storedFees.feeRecipient) {
        rows.push(["Fee Recipient", storedFees.feeRecipient]);
      }

      output.table(["Fee Type", "Value"], rows);
    });

  fees
    .command("configure")
    .description(
      "[DEPRECATED] Configure local fee settings (use `fees init` for on-chain)",
    )
    .argument("<vault>", "Vault address or alias")
    .option("--management <bps>", "Management fee in basis points (0-10000)")
    .option("--performance <bps>", "Performance fee in basis points (0-10000)")
    .option("--entry <bps>", "Entry fee in basis points (0-10000)")
    .option("--exit <bps>", "Exit fee in basis points (0-10000)")
    .option("--recipient <pubkey>", "Fee recipient address")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

      // Deprecation warning
      output.warn(
        "DEPRECATED: Local fee configuration is for preview only.\n" +
          "For on-chain enforcement, use: solana-vault fees init <vault> --recipient <pubkey>",
      );
      output.info("");

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      // Validate bps values
      const validateBps = (
        value: string | undefined,
        name: string,
      ): number | undefined => {
        if (value === undefined) return undefined;
        const bps = parseInt(value);
        if (isNaN(bps) || bps < 0 || bps > MAX_BPS) {
          output.error(`${name} must be between 0 and ${MAX_BPS} basis points`);
          process.exit(1);
        }
        return bps;
      };

      const managementFeeBps = validateBps(opts.management, "Management fee");
      const performanceFeeBps = validateBps(
        opts.performance,
        "Performance fee",
      );
      const entryFeeBps = validateBps(opts.entry, "Entry fee");
      const exitFeeBps = validateBps(opts.exit, "Exit fee");

      const existingFees = config.fees?.[vaultArg] as
        | {
            managementFeeBps: number;
            performanceFeeBps: number;
            entryFeeBps?: number;
            exitFeeBps?: number;
            feeRecipient?: string;
          }
        | undefined;

      // Parse fee recipient
      let feeRecipient: PublicKey;
      if (opts.recipient) {
        if (!isValidPublicKey(opts.recipient)) {
          output.error("Invalid fee recipient address");
          process.exit(1);
        }
        feeRecipient = new PublicKey(opts.recipient);
      } else if (existingFees?.feeRecipient) {
        feeRecipient = new PublicKey(existingFees.feeRecipient);
      } else {
        // Default to wallet's public key
        feeRecipient = provider.wallet.publicKey;
      }

      const newFeeConfig: FeeConfig = {
        managementFeeBps:
          managementFeeBps ?? existingFees?.managementFeeBps ?? 0,
        performanceFeeBps:
          performanceFeeBps ?? existingFees?.performanceFeeBps ?? 0,
        entryFeeBps: entryFeeBps ?? existingFees?.entryFeeBps,
        exitFeeBps: exitFeeBps ?? existingFees?.exitFeeBps,
        feeRecipient,
      };

      // Validate config
      if (!validateFeeConfig(newFeeConfig)) {
        output.error(
          "Invalid fee configuration - values must be between 0 and 10000 bps",
        );
        process.exit(1);
      }

      if (!config.fees) {
        config.fees = {};
      }
      // Store as serializable format
      config.fees[vaultArg] = {
        managementFeeBps: newFeeConfig.managementFeeBps,
        performanceFeeBps: newFeeConfig.performanceFeeBps,
        entryFeeBps: newFeeConfig.entryFeeBps,
        exitFeeBps: newFeeConfig.exitFeeBps,
        feeRecipient: newFeeConfig.feeRecipient.toBase58(),
      };

      saveConfig(config);

      output.success(`Fee configuration saved for ${vaultArg}`);

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          fees: {
            managementFeeBps: newFeeConfig.managementFeeBps,
            performanceFeeBps: newFeeConfig.performanceFeeBps,
            entryFeeBps: newFeeConfig.entryFeeBps,
            exitFeeBps: newFeeConfig.exitFeeBps,
            feeRecipient: newFeeConfig.feeRecipient.toBase58(),
          },
        });
      } else {
        output.info("");
        output.table(
          ["Fee Type", "Value"],
          [
            ["Management Fee", `${newFeeConfig.managementFeeBps} bps`],
            ["Performance Fee", `${newFeeConfig.performanceFeeBps} bps`],
            ["Entry Fee", `${newFeeConfig.entryFeeBps ?? 0} bps`],
            ["Exit Fee", `${newFeeConfig.exitFeeBps ?? 0} bps`],
          ],
        );
      }
    });

  fees
    .command("preview")
    .description("Preview fee collection amount")
    .argument("<vault>", "Vault address or alias")
    .option("--total-assets <amount>", "Current total assets", "0")
    .option("--total-shares <amount>", "Current total shares", "0")
    .option("--hours <number>", "Hours since last collection", "24")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, provider } = ctx;

      const storedFees = config.fees?.[vaultArg] as
        | {
            managementFeeBps: number;
            performanceFeeBps: number;
            entryFeeBps?: number;
            exitFeeBps?: number;
            feeRecipient?: string;
          }
        | undefined;

      if (!storedFees) {
        output.error(`No fee configuration for ${vaultArg}`);
        output.info(
          `Configure fees first: solana-vault fees configure ${vaultArg}`,
        );
        process.exit(1);
      }

      const totalAssets = new BN(opts.totalAssets);
      const totalShares = new BN(opts.totalShares);
      const hoursElapsed = parseFloat(opts.hours);
      const secondsElapsed = Math.floor(hoursElapsed * 3600);

      // Create FeeConfig from stored data
      const feeConfig: FeeConfig = {
        managementFeeBps: storedFees.managementFeeBps,
        performanceFeeBps: storedFees.performanceFeeBps,
        entryFeeBps: storedFees.entryFeeBps,
        exitFeeBps: storedFees.exitFeeBps,
        feeRecipient: storedFees.feeRecipient
          ? new PublicKey(storedFees.feeRecipient)
          : provider.wallet.publicKey,
      };

      const feeState = createInitialFeeState(
        Math.floor(Date.now() / 1000) - secondsElapsed,
      );

      const result = calculateAccruedFees(
        totalAssets,
        totalShares,
        feeConfig,
        feeState,
        Math.floor(Date.now() / 1000),
      );

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          preview: {
            managementFee: result.managementFee.toString(),
            performanceFee: result.performanceFee.toString(),
            totalFee: result.totalFee.toString(),
            netAssets: result.netAssets.toString(),
          },
        });
      } else {
        output.info(`Fee Preview for ${vaultArg}\n`);
        output.info(`Time elapsed: ${hoursElapsed} hours`);
        output.info(`Total assets: ${totalAssets.toString()}`);
        output.info("");
        output.table(
          ["Fee Type", "Amount"],
          [
            ["Management Fee", result.managementFee.toString()],
            ["Performance Fee", result.performanceFee.toString()],
            ["Total Fee", result.totalFee.toString()],
            ["Net Assets", result.netAssets.toString()],
          ],
        );
      }
    });

  fees
    .command("clear")
    .description("Clear fee configuration for a vault")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config, options } = ctx;

      if (!config.fees?.[vaultArg]) {
        output.info(`No fee configuration for ${vaultArg}`);
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          `Clear fee configuration for ${vaultArg}?`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      delete config.fees[vaultArg];
      saveConfig(config);

      output.success(`Fee configuration cleared for ${vaultArg}`);
    });
}
