/**
 * Vault Alias Resolution Module
 *
 * Resolves vault identifiers (aliases or addresses) to fully resolved
 * vault configurations with program ID, variant, and metadata.
 *
 * Aliases provide human-readable names for vaults, while direct addresses
 * are looked up in the config for associated metadata.
 *
 * @example
 * ```ts
 * import { resolveVault, addVaultAlias } from "./vault-aliases";
 *
 * // Resolve by alias
 * const vault = resolveVault("my-vault", config, "devnet");
 *
 * // Resolve by address
 * const vault = resolveVault("7xKY...", config, "devnet");
 *
 * // Add new alias
 * const updated = addVaultAlias(config, "new-vault", {
 *   address: "7xKY...",
 *   variant: "svs-1",
 * });
 * ```
 */

import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  CliConfig,
  VaultAlias,
  ResolvedVault,
  SvsVariant,
  SVS_PROGRAMS,
  Cluster,
} from "../types";

export function isValidPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function getVaultAlias(
  config: CliConfig,
  alias: string,
): VaultAlias | undefined {
  return config.vaults[alias];
}

export function resolveVault(
  vaultArg: string,
  config: CliConfig,
  cluster: Cluster = "devnet",
): ResolvedVault {
  if (isValidPublicKey(vaultArg)) {
    const alias = Object.entries(config.vaults).find(
      ([_, v]) => v.address === vaultArg,
    );

    if (alias) {
      const [name, vaultConfig] = alias;
      return resolveFromAlias(vaultConfig, name, cluster);
    }

    throw new Error(
      `Vault address "${vaultArg}" not found in config. Add it with:\n` +
        `  solana-vault config add-vault <alias> ${vaultArg} --variant svs-1`,
    );
  }

  const vaultConfig = config.vaults[vaultArg];
  if (!vaultConfig) {
    throw new Error(
      `Vault alias "${vaultArg}" not found. Available vaults:\n` +
        Object.keys(config.vaults)
          .map((k) => `  - ${k}`)
          .join("\n") || "  (none configured)",
    );
  }

  return resolveFromAlias(vaultConfig, vaultArg, cluster);
}

function resolveFromAlias(
  vaultConfig: VaultAlias,
  alias: string,
  cluster: Cluster,
): ResolvedVault {
  const programAddresses = SVS_PROGRAMS[vaultConfig.variant];
  const programAddress =
    vaultConfig.programId ||
    (cluster === "mainnet-beta"
      ? programAddresses.mainnet
      : programAddresses.devnet);

  if (!programAddress) {
    throw new Error(
      `No program ID configured for ${vaultConfig.variant} on ${cluster}`,
    );
  }

  return {
    address: new PublicKey(vaultConfig.address),
    variant: vaultConfig.variant,
    programId: new PublicKey(programAddress),
    alias,
    assetMint: vaultConfig.assetMint
      ? new PublicKey(vaultConfig.assetMint)
      : undefined,
    vaultId: vaultConfig.vaultId ? new BN(vaultConfig.vaultId) : undefined,
  };
}

export function addVaultAlias(
  config: CliConfig,
  alias: string,
  vault: VaultAlias,
): CliConfig {
  if (config.vaults[alias]) {
    throw new Error(
      `Vault alias "${alias}" already exists. Use a different name or remove it first.`,
    );
  }

  if (!isValidPublicKey(vault.address)) {
    throw new Error(`Invalid vault address: ${vault.address}`);
  }

  if (vault.programId && !isValidPublicKey(vault.programId)) {
    throw new Error(`Invalid program ID: ${vault.programId}`);
  }

  if (vault.assetMint && !isValidPublicKey(vault.assetMint)) {
    throw new Error(`Invalid asset mint: ${vault.assetMint}`);
  }

  return {
    ...config,
    vaults: {
      ...config.vaults,
      [alias]: vault,
    },
  };
}

export function removeVaultAlias(config: CliConfig, alias: string): CliConfig {
  if (!config.vaults[alias]) {
    throw new Error(`Vault alias "${alias}" not found`);
  }

  const { [alias]: _, ...rest } = config.vaults;
  return {
    ...config,
    vaults: rest,
  };
}

export function updateVaultAlias(
  config: CliConfig,
  alias: string,
  updates: Partial<VaultAlias>,
): CliConfig {
  const existing = config.vaults[alias];
  if (!existing) {
    throw new Error(`Vault alias "${alias}" not found`);
  }

  return {
    ...config,
    vaults: {
      ...config.vaults,
      [alias]: { ...existing, ...updates },
    },
  };
}

export function listVaultAliases(
  config: CliConfig,
): Array<[string, VaultAlias]> {
  return Object.entries(config.vaults);
}

export function getDefaultVault(config: CliConfig): string | undefined {
  const vaults = Object.keys(config.vaults);
  return vaults.length === 1 ? vaults[0] : undefined;
}
