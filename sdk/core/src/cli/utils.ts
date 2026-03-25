/**
 * CLI Utility Functions
 *
 * Shared helpers for vault resolution, IDL loading, config management,
 * and common validation patterns used across CLI commands.
 */

import { PublicKey } from "@solana/web3.js";
import { BN, AnchorProvider, Program } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { CliConfig, SvsVariant, OutputAdapter } from "./types";
import {
  resolveVault as resolveVaultAlias,
  isValidPublicKey,
} from "./config/vault-aliases";
import { SolanaVault } from "../vault";
import { AllocatorVaultClient } from "../svs9";

// Re-export for use by command files
export { isValidPublicKey } from "./config/vault-aliases";

/**
 * Derive cluster from RPC URL.
 */
export function getCluster(
  url?: string,
): "devnet" | "mainnet-beta" | "testnet" | "localnet" {
  if (!url) return "devnet";
  if (url.includes("mainnet")) return "mainnet-beta";
  if (url.includes("testnet")) return "testnet";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "localnet";
  return "devnet";
}

/**
 * Candidate base paths for IDL files.
 *
 * In the workspace, compiled CLI files live under `sdk/core/dist/cli`, while
 * Anchor emits IDLs to the repo root `target/idl`. We also keep fallbacks for
 * development-time execution and custom overrides.
 */
const IDL_BASE_PATHS = [
  process.env.SVS_IDL_DIR,
  path.resolve(process.cwd(), "target", "idl"),
  path.resolve(__dirname, "..", "..", "..", "..", "target", "idl"),
  path.resolve(__dirname, "..", "..", "target", "idl"),
].filter((p): p is string => Boolean(p));

/**
 * Find IDL file path for a given SVS variant.
 *
 * @param variant - Optional SVS variant (svs-1, svs-2, svs-3, svs-4, svs-9)
 * @returns Path to IDL file if found, null otherwise
 *
 * @example
 * ```ts
 * const idlPath = findIdlPath("svs-2");
 * if (!idlPath) {
 *   console.error("IDL not found. Run `anchor build` first.");
 * }
 * ```
 */
export function findIdlPath(variant?: SvsVariant): string | null {
  // Try variant-specific IDL first
  if (variant) {
    const idlName = variant.replace("-", "_") + ".json";
    for (const basePath of IDL_BASE_PATHS) {
      const idlPath = path.join(basePath, idlName);
      if (fs.existsSync(idlPath)) {
        return idlPath;
      }
    }
  }

  // Fall back to first available IDL
  const idlNames = ["svs_1.json", "svs_2.json", "svs_3.json", "svs_4.json", "svs_9.json"];
  for (const basePath of IDL_BASE_PATHS) {
    for (const name of idlNames) {
      const idlPath = path.join(basePath, name);
      if (fs.existsSync(idlPath)) {
        return idlPath;
      }
    }
  }

  return null;
}

/**
 * Load and parse IDL JSON file.
 *
 * @param idlPath - Absolute path to IDL JSON file
 * @returns Parsed IDL object
 * @throws If file doesn't exist or contains invalid JSON
 */
export function loadIdl(idlPath: string): unknown {
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

/**
 * Return true when the variant uses the allocator client.
 */
export function isAllocatorVariant(variant: SvsVariant): boolean {
  return variant === "svs-9";
}

/**
 * Load the correct IDL + Anchor program for a variant.
 */
export function loadProgramForVariant(
  provider: AnchorProvider,
  variant: SvsVariant,
  programId?: PublicKey,
): Program {
  const idlPath = findIdlPath(variant);
  if (!idlPath) {
    throw new Error(
      `IDL not found for ${variant}. Run \`anchor build -p ${variant.replace("-", "_")}\` first.`,
    );
  }

  const idl = loadIdl(idlPath) as Record<string, unknown>;
  if (programId) {
    idl.address = programId.toBase58();
  }
  return new Program(idl as any, provider);
}

/**
 * Get the CLI config file path.
 *
 * @returns Path to ~/.solana-vault/config.yaml
 */
export function getConfigPath(): string {
  return path.join(process.env.HOME || "~", ".solana-vault", "config.yaml");
}

/**
 * Save CLI config to disk.
 * Creates the config directory if it doesn't exist.
 *
 * @param config - CLI configuration to save
 */
export function saveConfig(config: CliConfig): void {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, yaml.stringify(config));
}

/**
 * Resolved vault parameters for command execution.
 */
export interface ResolvedVaultParams {
  /** Program ID for the vault's SVS variant */
  programId: PublicKey;
  /** Asset mint address */
  assetMint: PublicKey;
  /** Vault ID (for multi-vault deployments) */
  vaultId: BN;
  /** SVS variant (svs-1, svs-2, svs-3, svs-4, svs-9) */
  variant: SvsVariant;
}

export type SupportedVaultClient = SolanaVault | AllocatorVaultClient;

/**
 * Load the SDK client that matches the resolved vault variant.
 */
export async function loadVaultClient(
  provider: AnchorProvider,
  resolved: ResolvedVaultParams,
): Promise<SupportedVaultClient> {
  const program = loadProgramForVariant(
    provider,
    resolved.variant,
    resolved.programId,
  );

  if (isAllocatorVariant(resolved.variant)) {
    return AllocatorVaultClient.load(
      program,
      resolved.assetMint,
      resolved.vaultId,
    );
  }

  return SolanaVault.load(program, resolved.assetMint, resolved.vaultId);
}

/**
 * Resolve vault argument to full parameters.
 *
 * Handles both raw PublicKey addresses and vault aliases from config.
 * For raw addresses, requires --program-id and --asset-mint options.
 *
 * @param vaultArg - Vault address (base58) or alias name
 * @param config - CLI configuration with vault aliases
 * @param opts - Command options (programId, assetMint, vaultId)
 * @param output - Output adapter for error messages
 * @returns Resolved parameters or null on error
 *
 * @example
 * ```ts
 * const resolved = resolveVaultArg("my-vault", config, opts, output);
 * if (!resolved) process.exit(1);
 *
 * const vault = await SolanaVault.load(
 *   program,
 *   resolved.assetMint,
 *   resolved.vaultId
 * );
 * ```
 */
export function resolveVaultArg(
  vaultArg: string,
  config: CliConfig,
  opts: {
    programId?: string;
    assetMint?: string;
    vaultId?: string;
    variant?: string;
  },
  output: OutputAdapter,
): ResolvedVaultParams | null {
  const validVariants: SvsVariant[] = [
    "svs-1",
    "svs-2",
    "svs-3",
    "svs-4",
    "svs-9",
  ];

  if (opts.variant && !validVariants.includes(opts.variant as SvsVariant)) {
    output.error(
      `Invalid variant: ${opts.variant}. Use: ${validVariants.join(", ")}`,
    );
    return null;
  }

  // Raw PublicKey address
  if (isValidPublicKey(vaultArg)) {
    if (!opts.programId || !opts.assetMint) {
      output.error(
        "When using raw vault address, --program-id and --asset-mint are required",
      );
      return null;
    }
    return {
      programId: new PublicKey(opts.programId),
      assetMint: new PublicKey(opts.assetMint),
      vaultId: new BN(opts.vaultId || "1"),
      variant: (opts.variant as SvsVariant) || "svs-1",
    };
  }

  // Vault alias from config
  try {
    const resolved = resolveVaultAlias(vaultArg, config);
    if (!resolved.assetMint) {
      output.error(
        `Vault "${vaultArg}" missing assetMint. Update with:\n` +
          `  solana-vault config update-vault ${vaultArg} --asset-mint <ADDRESS>`,
      );
      return null;
    }
    return {
      programId: resolved.programId,
      assetMint: resolved.assetMint,
      vaultId: resolved.vaultId || new BN(opts.vaultId || "1"),
      variant: resolved.variant,
    };
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Check if the current wallet is the vault authority.
 *
 * @param walletPubkey - Current wallet's public key
 * @param authorityPubkey - Vault's authority public key
 * @param output - Output adapter for error messages
 * @returns true if wallet is authority, false otherwise
 */
export function checkAuthority(
  walletPubkey: PublicKey,
  authorityPubkey: PublicKey,
  output: OutputAdapter,
): boolean {
  if (!authorityPubkey.equals(walletPubkey)) {
    output.error(
      `Not vault authority. Your wallet: ${walletPubkey.toBase58()}, Authority: ${authorityPubkey.toBase58()}`,
    );
    return false;
  }
  return true;
}

/**
 * Format large numbers with thousands separators.
 *
 * @param value - Number, string, or BN to format
 * @returns Formatted string with commas
 *
 * @example
 * ```ts
 * formatNumber(1000000) // "1,000,000"
 * formatNumber(new BN("9999999")) // "9,999,999"
 * ```
 */
export function formatNumber(value: BN | string | number): string {
  const str = value.toString();
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
