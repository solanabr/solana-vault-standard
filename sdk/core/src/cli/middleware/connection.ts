/**
 * RPC Connection Module
 *
 * Establishes and manages Solana RPC connections with Anchor provider setup.
 * Handles connection health checks and cluster detection from URLs.
 */

import { Connection, Keypair } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Commitment } from "../types";
import { loadWallet } from "./wallet";

export interface ConnectionResult {
  connection: Connection;
  provider: AnchorProvider;
}

export async function setupConnection(
  url: string,
  commitment: Commitment = "confirmed",
  keypairPath?: string,
): Promise<ConnectionResult> {
  const connection = new Connection(url, commitment);

  let wallet: Wallet;
  if (keypairPath) {
    const keypair = loadWallet(keypairPath);
    wallet = new Wallet(keypair);
  } else {
    wallet = new Wallet(Keypair.generate());
  }

  const provider = new AnchorProvider(connection, wallet, {
    commitment,
  });

  return { connection, provider };
}

export async function checkConnection(connection: Connection): Promise<{
  connected: boolean;
  slot?: number;
  blockTime?: number;
  version?: string;
  error?: string;
}> {
  try {
    const [slot, version] = await Promise.all([
      connection.getSlot(),
      connection.getVersion(),
    ]);

    let blockTime: number | undefined;
    try {
      const bt = await connection.getBlockTime(slot);
      blockTime = bt || undefined;
    } catch {
      // Block time might not be available
    }

    return {
      connected: true,
      slot,
      blockTime,
      version: version["solana-core"],
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getClusterFromUrl(url: string): string {
  if (url.includes("mainnet")) return "mainnet-beta";
  if (url.includes("testnet")) return "testnet";
  if (url.includes("devnet")) return "devnet";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "localnet";
  return "custom";
}
