/**
 * CLI Configuration Schema
 *
 * Zod schemas for validating CLI configuration files. Defines the structure
 * for vault aliases, profiles, autopilot settings, guards, and alerts.
 *
 * Configuration is validated on load and save to ensure type safety.
 */

import { z } from "zod";

const ClusterSchema = z.enum(["devnet", "mainnet-beta", "testnet", "localnet"]);
const CommitmentSchema = z.enum(["processed", "confirmed", "finalized"]);
const OutputFormatSchema = z.enum(["table", "json", "csv"]);
const SvsVariantSchema = z.enum(["svs-1", "svs-2", "svs-3", "svs-4"]);

const ProfileConfigSchema = z.object({
  cluster: ClusterSchema.optional(),
  keypair: z.string().optional(),
  confirmation: CommitmentSchema.optional(),
  rpcEndpoint: z.string().url().optional(),
});

const VaultAliasSchema = z.object({
  address: z.string().min(32).max(44),
  variant: SvsVariantSchema,
  programId: z.string().min(32).max(44).optional(),
  assetMint: z.string().min(32).max(44).optional(),
  vaultId: z.number().int().positive().optional(),
  name: z.string().optional(),
});

const SyncConfigSchema = z.object({
  enabled: z.boolean(),
  interval: z.string(),
  minChange: z.number().optional(),
  lastRun: z.string().optional(),
});

const FeesConfigSchema = z.object({
  enabled: z.boolean(),
  threshold: z.string(),
  recipient: z.string().optional(),
  lastRun: z.string().optional(),
});

const HealthCheckConfigSchema = z.object({
  enabled: z.boolean(),
  interval: z.string(),
  alertWebhook: z.string().url().optional(),
  lastRun: z.string().optional(),
});

const PauseTriggerSchema = z.object({
  type: z.enum(["large_withdrawal", "rapid_activity", "price_deviation"]),
  threshold: z.number(),
  notify: z.array(z.string()).optional(),
});

const PauseConfigSchema = z.object({
  enabled: z.boolean(),
  triggers: z.array(PauseTriggerSchema),
});

const AutopilotConfigSchema = z.object({
  sync: SyncConfigSchema.optional(),
  fees: FeesConfigSchema.optional(),
  pause: PauseConfigSchema.optional(),
  healthCheck: HealthCheckConfigSchema.optional(),
});

const AnomalyThresholdsSchema = z.object({
  priceChangePercent: z.number().optional(),
  volumeSpike: z.number().optional(),
});

const GuardConfigSchema = z.object({
  maxDepositPerTx: z.string().optional(),
  maxWithdrawPerTx: z.string().optional(),
  dailyDepositLimit: z.string().optional(),
  dailyWithdrawLimit: z.string().optional(),
  cooldownSeconds: z.number().optional(),
  pauseOnAnomaly: z.boolean().optional(),
  anomalyThresholds: AnomalyThresholdsSchema.optional(),
});

const AlertsConfigSchema = z.object({
  discord: z.string().url().optional(),
  email: z.string().email().optional(),
  slack: z.string().url().optional(),
});

const DefaultsSchema = z.object({
  cluster: ClusterSchema,
  keypair: z.string(),
  output: OutputFormatSchema,
  confirmation: CommitmentSchema,
});

export const CliConfigSchema = z.object({
  defaults: DefaultsSchema,
  profiles: z.record(z.string(), ProfileConfigSchema).default({}),
  vaults: z.record(z.string(), VaultAliasSchema).default({}),
  autopilot: z.record(z.string(), AutopilotConfigSchema).optional(),
  guards: z.record(z.string(), GuardConfigSchema).optional(),
  alerts: AlertsConfigSchema.optional(),
});

export type CliConfigInput = z.input<typeof CliConfigSchema>;
export type CliConfigOutput = z.output<typeof CliConfigSchema>;

export function validateConfig(config: unknown): CliConfigOutput {
  return CliConfigSchema.parse(config);
}

export function safeValidateConfig(
  config: unknown,
):
  | { success: true; data: CliConfigOutput }
  | { success: false; error: z.ZodError } {
  const result = CliConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
