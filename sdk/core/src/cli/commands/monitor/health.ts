/** Health Command - Check RPC, program, and vault health status */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { SVS_PROGRAMS, SvsVariant } from "../../types";
import { resolveVault, isValidPublicKey } from "../../config/vault-aliases";

interface HealthCheckResult {
  cluster: string;
  rpcUrl: string;
  clusterVersion?: string;
  programs: Record<string, ProgramStatus>;
  vault?: VaultStatus;
  healthy: boolean;
}

interface ProgramStatus {
  address: string;
  deployed: boolean;
  executable: boolean;
  error?: string;
}

interface VaultStatus {
  address: string;
  exists: boolean;
  size?: number;
  owner?: string;
  error?: string;
}

export function registerHealthCommand(program: Command): void {
  program
    .command("health")
    .description("Check health of SVS programs and vaults")
    .argument("[vault]", "Optional vault address or alias to check")
    .option("--variant <variant>", "Only check specific SVS variant")
    .option("--all", "Check all SVS program variants")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config, connection } = ctx;

      const result: HealthCheckResult = {
        cluster: config.defaults.cluster,
        rpcUrl: connection.rpcEndpoint,
        programs: {},
        healthy: true,
      };

      output.info(`Health Check`);
      output.info(`Cluster: ${result.cluster}`);
      output.info(`RPC: ${result.rpcUrl}\n`);

      // 1. Check cluster connectivity
      try {
        const version = await connection.getVersion();
        result.clusterVersion = version["solana-core"];
        output.success(
          `Cluster reachable (solana-core ${result.clusterVersion})`,
        );
      } catch (error) {
        output.error(
          `Cluster unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
        result.healthy = false;

        if (globalOpts.output === "json") {
          output.json(result);
        }
        process.exit(1);
      }

      // 2. Check programs
      const programsToCheck: Record<string, string> = {};
      const cluster = config.defaults.cluster;
      const clusterKey = cluster === "mainnet-beta" ? "mainnet" : "devnet";

      const getProgramAddress = (variant: SvsVariant): string | undefined => {
        const addresses = SVS_PROGRAMS[variant];
        return clusterKey === "mainnet" ? addresses.mainnet : addresses.devnet;
      };

      if (opts.variant) {
        const variant = opts.variant as SvsVariant;
        if (!SVS_PROGRAMS[variant]) {
          output.error(
            `Invalid variant: ${opts.variant}. Use: svs-1, svs-2, svs-3, svs-4`,
          );
          process.exit(1);
        }
        const addr = getProgramAddress(variant);
        if (addr) programsToCheck[variant] = addr;
      } else if (opts.all) {
        for (const [variant] of Object.entries(SVS_PROGRAMS)) {
          const addr = getProgramAddress(variant as SvsVariant);
          if (addr) programsToCheck[variant] = addr;
        }
      } else if (vaultArg) {
        try {
          const resolved = resolveVault(vaultArg, config);
          programsToCheck[resolved.variant] = resolved.programId.toBase58();
        } catch {
          for (const [variant] of Object.entries(SVS_PROGRAMS)) {
            const addr = getProgramAddress(variant as SvsVariant);
            if (addr) programsToCheck[variant] = addr;
          }
        }
      } else {
        for (const [variant] of Object.entries(SVS_PROGRAMS)) {
          const addr = getProgramAddress(variant as SvsVariant);
          if (addr) programsToCheck[variant] = addr;
        }
      }

      output.info("\nProgram Status:");

      for (const [name, address] of Object.entries(programsToCheck)) {
        const status: ProgramStatus = {
          address,
          deployed: false,
          executable: false,
        };

        try {
          const pubkey = new PublicKey(address);
          const accountInfo = await connection.getAccountInfo(pubkey);

          if (accountInfo && accountInfo.executable) {
            status.deployed = true;
            status.executable = true;
            output.success(`${name}: deployed (${address.slice(0, 8)}...)`);
          } else if (accountInfo) {
            status.deployed = true;
            status.executable = false;
            output.warn(
              `${name}: exists but not executable (${address.slice(0, 8)}...)`,
            );
            result.healthy = false;
          } else {
            output.error(`${name}: not found (${address.slice(0, 8)}...)`);
            result.healthy = false;
          }
        } catch (error) {
          status.error = error instanceof Error ? error.message : String(error);
          output.error(`${name}: check failed - ${status.error}`);
          result.healthy = false;
        }

        result.programs[name] = status;
      }

      // 3. Check vault if provided
      if (vaultArg) {
        output.info("\nVault Status:");

        let vaultAddress: PublicKey;

        if (isValidPublicKey(vaultArg)) {
          vaultAddress = new PublicKey(vaultArg);
        } else {
          try {
            const resolved = resolveVault(vaultArg, config);
            vaultAddress = resolved.address;
          } catch (error) {
            output.error(
              `Could not resolve vault: ${error instanceof Error ? error.message : String(error)}`,
            );
            result.healthy = false;

            if (globalOpts.output === "json") {
              output.json(result);
            }
            process.exit(1);
          }
        }

        const vaultStatus: VaultStatus = {
          address: vaultAddress.toBase58(),
          exists: false,
        };

        try {
          const vaultInfo = await connection.getAccountInfo(vaultAddress);

          if (vaultInfo) {
            vaultStatus.exists = true;
            vaultStatus.size = vaultInfo.data.length;
            vaultStatus.owner = vaultInfo.owner.toBase58();
            output.success(`Vault exists (${vaultStatus.size} bytes)`);
            output.info(`Owner: ${vaultStatus.owner}`);
          } else {
            output.error("Vault account not found");
            result.healthy = false;
          }
        } catch (error) {
          vaultStatus.error =
            error instanceof Error ? error.message : String(error);
          output.error(`Vault check failed: ${vaultStatus.error}`);
          result.healthy = false;
        }

        result.vault = vaultStatus;
      }

      // Summary
      output.info("");
      if (result.healthy) {
        output.success("All checks passed");
      } else {
        output.error("Some checks failed");
      }

      if (globalOpts.output === "json") {
        output.json(result);
      }

      process.exit(result.healthy ? 0 : 1);
    });
}
