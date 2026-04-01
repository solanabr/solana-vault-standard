/**
 * Wallet Loading Module
 *
 * Loads Solana keypairs from filesystem with path resolution.
 * Supports tilde expansion (~/) and relative paths.
 */

import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function loadWallet(keypairPath: string): Keypair {
  const resolved = resolvePath(keypairPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Keypair file not found: ${resolved}\n` +
        `Create one with: solana-keygen new -o ${resolved}`,
    );
  }

  // Warn if keypair file has overly permissive permissions (Unix only)
  if (process.platform !== "win32") {
    try {
      const stat = fs.statSync(resolved);
      const mode = stat.mode & 0o777;
      if (mode & 0o077) {
        console.warn(
          `WARNING: Keypair file ${resolved} has permissions ${mode.toString(8)}. ` +
            `Expected 0600. Fix with: chmod 600 ${resolved}`,
        );
      }
    } catch {
      // Non-fatal: skip permission check if stat fails
    }
  }

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    const secretKey = JSON.parse(content);

    if (!Array.isArray(secretKey) || secretKey.length !== 64) {
      throw new Error("Invalid keypair format: expected array of 64 bytes");
    }

    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid keypair file format: ${resolved}`);
    }
    throw error;
  }
}

export function resolvePath(filepath: string): string {
  if (filepath.startsWith("~")) {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return path.resolve(filepath);
}

export function getDefaultKeypairPath(): string {
  return path.join(os.homedir(), ".config", "solana", "id.json");
}

export function keypairExists(keypairPath: string): boolean {
  return fs.existsSync(resolvePath(keypairPath));
}

export function formatPublicKey(keypair: Keypair, truncate = false): string {
  const pubkey = keypair.publicKey.toBase58();
  if (truncate) {
    return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
  }
  return pubkey;
}
