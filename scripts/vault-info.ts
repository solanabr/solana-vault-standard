/**
 * Vault Info Script
 *
 * Reads and displays vault state from a deployed SVS program.
 *
 * Usage:
 *   npx ts-node scripts/vault-info.ts <VAULT_ADDRESS> --cluster devnet
 *   npx ts-node scripts/vault-info.ts <VAULT_ADDRESS> --cluster devnet --program svs-1
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import {
  getAccount,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const SVS_PROGRAMS: Record<string, string> = {
  "svs-1": "SVS1VauLt1111111111111111111111111111111111",
  "svs-2": "SVS2VauLt2222222222222222222222222222222222",
};

// Vault account layout offsets (after 8-byte discriminator)
const VAULT_LAYOUT = {
  authority: { offset: 8, size: 32 },
  assetMint: { offset: 40, size: 32 },
  sharesMint: { offset: 72, size: 32 },
  assetVault: { offset: 104, size: 32 },
  totalAssets: { offset: 136, size: 8 },
  decimalsOffset: { offset: 144, size: 1 },
  bump: { offset: 145, size: 1 },
  paused: { offset: 146, size: 1 },
  vaultId: { offset: 147, size: 8 },
};

function parseArgs(): {
  vaultAddress: string;
  cluster: string;
  program: string;
} {
  const args = process.argv.slice(2);
  const vaultAddress = args[0];

  if (!vaultAddress || vaultAddress.startsWith("--")) {
    console.error("Usage: npx ts-node scripts/vault-info.ts <VAULT_ADDRESS> --cluster devnet");
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (args[i].startsWith("--")) {
      flags[args[i].replace("--", "")] = args[i + 1];
    }
  }

  return {
    vaultAddress,
    cluster: flags.cluster || "devnet",
    program: flags.program || "svs-1",
  };
}

function getConnectionUrl(cluster: string): string {
  if (cluster === "localnet" || cluster === "localhost") {
    return "http://127.0.0.1:8899";
  }
  return clusterApiUrl(cluster as "devnet" | "mainnet-beta" | "testnet");
}

function readPubkey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function readU8(data: Buffer, offset: number): number {
  return data.readUInt8(offset);
}

async function main() {
  const { vaultAddress, cluster, program } = parseArgs();
  const url = getConnectionUrl(cluster);
  const connection = new Connection(url, "confirmed");

  console.log(`\n📦 SVS Vault Info`);
  console.log(`   Cluster:  ${cluster}`);
  console.log(`   Program:  ${program}`);
  console.log(`   Vault:    ${vaultAddress}\n`);

  // Fetch vault account
  const vaultPubkey = new PublicKey(vaultAddress);
  const vaultInfo = await connection.getAccountInfo(vaultPubkey);

  if (!vaultInfo) {
    console.error("❌ Vault account not found");
    process.exit(1);
  }

  const data = vaultInfo.data;

  // Parse vault state
  const authority = readPubkey(data, VAULT_LAYOUT.authority.offset);
  const assetMint = readPubkey(data, VAULT_LAYOUT.assetMint.offset);
  const sharesMint = readPubkey(data, VAULT_LAYOUT.sharesMint.offset);
  const assetVault = readPubkey(data, VAULT_LAYOUT.assetVault.offset);
  const storedTotalAssets = readU64(data, VAULT_LAYOUT.totalAssets.offset);
  const decimalsOffset = readU8(data, VAULT_LAYOUT.decimalsOffset.offset);
  const bump = readU8(data, VAULT_LAYOUT.bump.offset);
  const paused = readU8(data, VAULT_LAYOUT.paused.offset) !== 0;
  const vaultId = readU64(data, VAULT_LAYOUT.vaultId.offset);

  console.log("── Vault State ──────────────────────────────────────");
  console.log(`  Authority:       ${authority.toBase58()}`);
  console.log(`  Asset Mint:      ${assetMint.toBase58()}`);
  console.log(`  Shares Mint:     ${sharesMint.toBase58()}`);
  console.log(`  Asset Vault:     ${assetVault.toBase58()}`);
  console.log(`  Vault ID:        ${vaultId}`);
  console.log(`  Decimals Offset: ${decimalsOffset}`);
  console.log(`  Bump:            ${bump}`);
  console.log(`  Paused:          ${paused ? "⛔ YES" : "✅ NO"}`);
  console.log(`  Stored Assets:   ${storedTotalAssets}`);

  // Fetch live balance from asset vault
  try {
    const assetVaultAccount = await getAccount(connection, assetVault, undefined, TOKEN_PROGRAM_ID);
    const liveBalance = assetVaultAccount.amount;
    console.log(`  Live Balance:    ${liveBalance}`);

    if (program === "svs-1" || program === "svs-3") {
      console.log(`  (SVS-1/3 uses live balance for all calculations)`);
    } else {
      const diff = BigInt(liveBalance) - storedTotalAssets;
      if (diff !== 0n) {
        console.log(`  ⚠️  Desync:       ${diff > 0n ? "+" : ""}${diff} (needs sync())`);
      }
    }
  } catch {
    console.log(`  Live Balance:    ❌ Could not fetch`);
  }

  // Fetch shares mint supply
  try {
    const sharesMintAccount = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
    const totalShares = sharesMintAccount.supply;
    console.log(`  Total Shares:    ${totalShares}`);
    console.log(`  Shares Decimals: ${sharesMintAccount.decimals}`);

    // Calculate exchange rate
    const liveBalance = (await getAccount(connection, assetVault, undefined, TOKEN_PROGRAM_ID)).amount;
    if (totalShares > 0n) {
      const offset = 10n ** BigInt(decimalsOffset);
      const virtualShares = BigInt(totalShares) + offset;
      const virtualAssets = BigInt(liveBalance) + 1n;
      const rateNum = Number(virtualAssets) / Number(virtualShares);
      console.log(`\n── Exchange Rate ───────────────────────────────────`);
      console.log(`  1 share = ${rateNum.toFixed(9)} assets`);
      console.log(`  1 asset = ${(1 / rateNum).toFixed(9)} shares`);
    }
  } catch {
    console.log(`  Total Shares:    ❌ Could not fetch`);
  }

  console.log(`\n── Owner ───────────────────────────────────────────`);
  console.log(`  Program:         ${vaultInfo.owner.toBase58()}`);
  console.log(`  Data Length:     ${vaultInfo.data.length} bytes`);
  console.log();
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
