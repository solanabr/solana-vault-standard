/**
 * CLI Configuration Module
 *
 * Manages CLI configuration with multi-layer resolution:
 * 1. Default values (built-in)
 * 2. Global config (~/.solana-vault/config.yaml)
 * 3. Local config (./.solana-vault.yaml)
 * 4. Environment variable (SOLANA_VAULT_CONFIG)
 * 5. Command-line options (highest priority)
 *
 * Supports named profiles for different environments (devnet, mainnet, etc.).
 *
 * @example
 * ```ts
 * import { loadConfig, applyProfile, saveConfig } from "./config";
 *
 * // Load merged configuration
 * const config = loadConfig();
 *
 * // Apply named profile
 * const mainnetConfig = applyProfile(config, "mainnet");
 *
 * // Save updated config
 * saveConfig(config);
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import YAML from "yaml";
import {
  CliConfig,
  DEFAULT_CONFIG,
  ProfileConfig,
  GlobalOptions,
} from "../types";
import { validateConfig, safeValidateConfig } from "./schema";

const CONFIG_FILENAME = "config.yaml";
const CONFIG_DIR = ".solana-vault";

export function getConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR);
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILENAME);
}

export function getLocalConfigPath(): string {
  return path.join(process.cwd(), `.${CONFIG_DIR}.yaml`);
}

export function configExists(): boolean {
  return fs.existsSync(getConfigPath());
}

export function localConfigExists(): boolean {
  return fs.existsSync(getLocalConfigPath());
}

export function loadConfigFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");
  return YAML.parse(content);
}

export function loadConfig(): CliConfig {
  let config: CliConfig = { ...DEFAULT_CONFIG };

  if (configExists()) {
    try {
      const userConfig = loadConfigFile(getConfigPath());
      const validated = safeValidateConfig(userConfig);
      if (validated.success) {
        config = mergeConfigs(config, validated.data);
      }
    } catch {
      // Silently use defaults if config is invalid
    }
  }

  if (localConfigExists()) {
    try {
      const localConfig = loadConfigFile(getLocalConfigPath());
      const validated = safeValidateConfig(localConfig);
      if (validated.success) {
        config = mergeConfigs(config, validated.data);
      }
    } catch {
      // Silently ignore invalid local config
    }
  }

  const envConfig = process.env.SOLANA_VAULT_CONFIG;
  if (envConfig && fs.existsSync(envConfig)) {
    try {
      const envFileConfig = loadConfigFile(envConfig);
      const validated = safeValidateConfig(envFileConfig);
      if (validated.success) {
        config = mergeConfigs(config, validated.data);
      }
    } catch {
      // Silently ignore invalid env config
    }
  }

  return config;
}

export function mergeConfigs(
  base: CliConfig,
  override: Partial<CliConfig>,
): CliConfig {
  return {
    defaults: {
      ...base.defaults,
      ...(override.defaults || {}),
    },
    profiles: {
      ...base.profiles,
      ...(override.profiles || {}),
    },
    vaults: {
      ...base.vaults,
      ...(override.vaults || {}),
    },
    autopilot: override.autopilot
      ? { ...base.autopilot, ...override.autopilot }
      : base.autopilot,
    alerts: override.alerts
      ? { ...base.alerts, ...override.alerts }
      : base.alerts,
  };
}

export function applyProfile(
  config: CliConfig,
  profileName: string,
): CliConfig {
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(`Profile "${profileName}" not found in configuration`);
  }

  return {
    ...config,
    defaults: {
      ...config.defaults,
      ...(profile.cluster && { cluster: profile.cluster }),
      ...(profile.keypair && { keypair: profile.keypair }),
      ...(profile.confirmation && { confirmation: profile.confirmation }),
    },
  };
}

export function applyGlobalOptions(
  config: CliConfig,
  options: GlobalOptions,
): CliConfig {
  let result = config;

  if (options.profile) {
    result = applyProfile(result, options.profile);
  }

  return {
    ...result,
    defaults: {
      ...result.defaults,
      ...(options.output && { output: options.output }),
    },
  };
}

export function saveConfig(config: CliConfig): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const validated = validateConfig(config);
  const content = YAML.stringify(validated, { indent: 2 });
  fs.writeFileSync(getConfigPath(), content, "utf-8");
}

export function initConfig(): CliConfig {
  if (configExists()) {
    return loadConfig();
  }

  saveConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export function getProfile(
  config: CliConfig,
  name: string,
): ProfileConfig | undefined {
  return config.profiles[name];
}

export function setProfile(
  config: CliConfig,
  name: string,
  profile: ProfileConfig,
): CliConfig {
  return {
    ...config,
    profiles: {
      ...config.profiles,
      [name]: profile,
    },
  };
}

export function deleteProfile(config: CliConfig, name: string): CliConfig {
  const { [name]: _, ...rest } = config.profiles;
  return {
    ...config,
    profiles: rest,
  };
}

export function listProfiles(config: CliConfig): string[] {
  return Object.keys(config.profiles);
}

export { validateConfig, safeValidateConfig };
