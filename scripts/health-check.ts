/**
 * Health Check Script
 *
 * Verifies a deployed SVS program is accessible and optionally queries a vault.
 *
 * Usage:
 *   npx ts-node scripts/health-check.ts --cluster devnet
 *   npx ts-node scripts/health-check.ts --cluster devnet --program SVS1VauLt1111111111111111111111111111111111
 *   npx ts-node scripts/health-check.ts --cluster devnet --vault <VAULT_ADDRESS>
 *
 * Exit codes:
 *   0 = healthy
 *   1 = failure
 */

import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

const SVS_PROGRAMS: Record<string, string> = {
  "svs-1": "Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC",
  "svs-2": "3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD",
  "svs-3": "EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh",
  "svs-4": "2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY",
};

function parseArgs(): {
  cluster: string;
  program?: string;
  vault?: string;
} {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace("--", "");
    result[key] = args[i + 1];
  }

  return {
    cluster: result.cluster || "devnet",
    program: result.program,
    vault: result.vault,
  };
}

function getConnectionUrl(cluster: string): string {
  if (cluster === "localnet" || cluster === "localhost") {
    return "http://127.0.0.1:8899";
  }
  return clusterApiUrl(cluster as "devnet" | "mainnet-beta" | "testnet");
}

async function main() {
  const { cluster, program, vault } = parseArgs();
  const url = getConnectionUrl(cluster);
  const connection = new Connection(url, "confirmed");

  console.log(`\n🔍 SVS Health Check`);
  console.log(`   Cluster: ${cluster}`);
  console.log(`   RPC:     ${url}\n`);

  let healthy = true;

  // 1. Check cluster connectivity
  try {
    const version = await connection.getVersion();
    console.log(`✅ Cluster reachable (solana-core ${version["solana-core"]})`);
  } catch (err: any) {
    console.error(`❌ Cluster unreachable: ${err.message}`);
    process.exit(1);
  }

  // 2. Check specific program or all programs
  const programsToCheck = program
    ? { custom: program }
    : SVS_PROGRAMS;

  for (const [name, address] of Object.entries(programsToCheck)) {
    try {
      const pubkey = new PublicKey(address);
      const accountInfo = await connection.getAccountInfo(pubkey);

      if (accountInfo && accountInfo.executable) {
        console.log(`✅ ${name} deployed (${address.slice(0, 12)}...)`);
      } else if (accountInfo) {
        console.log(`⚠️  ${name} exists but not executable (${address.slice(0, 12)}...)`);
        healthy = false;
      } else {
        console.log(`❌ ${name} not found (${address.slice(0, 12)}...)`);
        healthy = false;
      }
    } catch (err: any) {
      console.error(`❌ ${name} check failed: ${err.message}`);
      healthy = false;
    }
  }

  // 3. Optionally check a specific vault
  if (vault) {
    try {
      const vaultPubkey = new PublicKey(vault);
      const vaultInfo = await connection.getAccountInfo(vaultPubkey);

      if (vaultInfo) {
        console.log(`✅ Vault account exists (${vaultInfo.data.length} bytes)`);
      } else {
        console.log(`❌ Vault account not found`);
        healthy = false;
      }
    } catch (err: any) {
      console.error(`❌ Vault check failed: ${err.message}`);
      healthy = false;
    }
  }

  // Summary
  console.log(healthy ? "\n✅ All checks passed" : "\n❌ Some checks failed");
  process.exit(healthy ? 0 : 1);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
