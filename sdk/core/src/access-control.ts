/**
 * Access Control Module (Client-Side Preview)
 *
 * @deprecated For enforcement, use on-chain AccessConfig module.
 * This module is retained for client-side access PREVIEW and
 * merkle proof generation. On-chain enforcement is handled by
 * the svs-access module when the vault program is built with
 * the "modules" feature.
 *
 * For on-chain module PDAs, see:
 * - `getAccessConfigAddress()` from "./modules"
 * - `getFrozenAccountAddress()` from "./modules"
 * - `AccessConfigAccount`, `FrozenAccountState` types from "./modules"
 * - `AccessMode` enum from "./modules" (on-chain compatible)
 *
 * Address-based access management for SVS vaults. Supports:
 * - Open mode: Anyone can deposit
 * - Whitelist mode: Only approved addresses can deposit
 * - Blacklist mode: All except blocked addresses can deposit
 *
 * Whitelist verification supports both:
 * - Direct address set (simple, for small lists)
 * - Merkle proof verification (gas-efficient for large lists)
 *
 * @example
 * ```ts
 * import { checkAccess, verifyMerkleProof, buildMerkleTree } from "./access-control";
 *
 * // Simple whitelist check (PREVIEW ONLY)
 * const result = checkAccess(config, userAddress);
 * if (!result.allowed) {
 *   console.log(`Access denied: ${result.reason}`);
 * }
 *
 * // Build merkle tree for on-chain verification
 * const { root, proofs } = buildMerkleTree(addresses);
 * // Upload root to AccessConfig on-chain, pass proof to deposit instruction
 * ```
 */

import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

/**
 * Access control mode
 */
export enum AccessMode {
  /** Anyone can deposit */
  Open = "OPEN",
  /** Only whitelisted addresses can deposit */
  Whitelist = "WHITELIST",
  /** All except blacklisted addresses can deposit */
  Blacklist = "BLACKLIST",
}

/**
 * Access control configuration
 */
export interface AccessConfig {
  /** Current access mode */
  mode: AccessMode;
  /** Merkle root for whitelist verification (32 bytes) */
  merkleRoot: Buffer | null;
  /** Direct address set for simple mode (without merkle) */
  addresses: Set<string>;
}

/**
 * Reason for access denial
 */
export enum AccessDenialReason {
  NotWhitelisted = "NOT_WHITELISTED",
  Blacklisted = "BLACKLISTED",
  InvalidProof = "INVALID_PROOF",
}

/**
 * Result of an access check
 */
export interface AccessCheckResult {
  /** Whether access is allowed */
  allowed: boolean;
  /** Reason if denied */
  reason?: AccessDenialReason;
}

/**
 * Merkle proof for address verification
 */
export interface MerkleProof {
  /** Array of sibling hashes (each 32 bytes) */
  proof: Buffer[];
  /** Leaf hash (32 bytes) */
  leaf: Buffer;
}

/**
 * Hash a value using keccak256.
 */
function keccak256(data: Buffer): Buffer {
  return createHash("sha3-256").update(data).digest();
}

/**
 * Create a leaf hash from a public key.
 */
export function hashLeaf(address: PublicKey): Buffer {
  return keccak256(address.toBuffer());
}

/**
 * Combine two hashes for parent node.
 * Hashes are sorted before combining for consistent tree structure.
 */
function hashPair(a: Buffer, b: Buffer): Buffer {
  // Sort to ensure consistent tree regardless of order
  const sorted = Buffer.compare(a, b) < 0 ? [a, b] : [b, a];
  return keccak256(Buffer.concat(sorted));
}

/**
 * Generate merkle root from a list of addresses.
 */
export function generateMerkleRoot(addresses: PublicKey[]): Buffer {
  if (addresses.length === 0) {
    return Buffer.alloc(32);
  }

  // Create leaf hashes
  let level: Buffer[] = addresses.map(hashLeaf);

  // Build tree bottom-up
  while (level.length > 1) {
    const nextLevel: Buffer[] = [];

    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        nextLevel.push(hashPair(level[i], level[i + 1]));
      } else {
        // Odd number of nodes: promote the last one
        nextLevel.push(level[i]);
      }
    }

    level = nextLevel;
  }

  return level[0];
}

/**
 * Generate merkle proof for an address.
 * Returns null if address is not in the list.
 */
export function generateMerkleProof(
  address: PublicKey,
  addresses: PublicKey[],
): MerkleProof | null {
  const leaf = hashLeaf(address);
  const leafIndex = addresses.findIndex((a) => a.equals(address));

  if (leafIndex === -1) {
    return null;
  }

  // Create all leaf hashes
  let level: Buffer[] = addresses.map(hashLeaf);
  let index = leafIndex;
  const proof: Buffer[] = [];

  // Build proof while constructing tree
  while (level.length > 1) {
    const nextLevel: Buffer[] = [];

    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        nextLevel.push(hashPair(level[i], level[i + 1]));

        // If this is the pair containing our index, add sibling to proof
        if (i === index || i + 1 === index) {
          const siblingIndex = i === index ? i + 1 : i;
          proof.push(level[siblingIndex]);
        }
      } else {
        // Odd node, no sibling
        nextLevel.push(level[i]);
      }
    }

    index = Math.floor(index / 2);
    level = nextLevel;
  }

  return { proof, leaf };
}

/**
 * Verify merkle proof for an address.
 */
export function verifyMerkleProof(
  address: PublicKey,
  proof: MerkleProof,
  root: Buffer,
): boolean {
  const leaf = hashLeaf(address);

  // Check leaf matches
  if (!leaf.equals(proof.leaf)) {
    return false;
  }

  // Compute root from proof
  let computed = leaf;
  for (const sibling of proof.proof) {
    computed = hashPair(computed, sibling);
  }

  return computed.equals(root);
}

/**
 * Check if an address has access based on configuration.
 */
export function checkAccess(
  address: PublicKey,
  config: AccessConfig,
  merkleProof?: MerkleProof,
): AccessCheckResult {
  const addressStr = address.toBase58();

  switch (config.mode) {
    case AccessMode.Open:
      return { allowed: true };

    case AccessMode.Whitelist:
      // Check direct address list first
      if (config.addresses.has(addressStr)) {
        return { allowed: true };
      }

      // Check merkle proof if root is set
      if (config.merkleRoot && merkleProof) {
        if (verifyMerkleProof(address, merkleProof, config.merkleRoot)) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: AccessDenialReason.InvalidProof,
        };
      }

      return {
        allowed: false,
        reason: AccessDenialReason.NotWhitelisted,
      };

    case AccessMode.Blacklist:
      if (config.addresses.has(addressStr)) {
        return {
          allowed: false,
          reason: AccessDenialReason.Blacklisted,
        };
      }
      return { allowed: true };

    default:
      return { allowed: true };
  }
}

/**
 * Add an address to the list.
 * Returns new config (immutable).
 */
export function addToList(
  config: AccessConfig,
  address: PublicKey,
): AccessConfig {
  const newAddresses = new Set(config.addresses);
  newAddresses.add(address.toBase58());

  return {
    ...config,
    addresses: newAddresses,
  };
}

/**
 * Remove an address from the list.
 * Returns new config (immutable).
 */
export function removeFromList(
  config: AccessConfig,
  address: PublicKey,
): AccessConfig {
  const newAddresses = new Set(config.addresses);
  newAddresses.delete(address.toBase58());

  return {
    ...config,
    addresses: newAddresses,
  };
}

/**
 * Update the merkle root in config.
 * Returns new config (immutable).
 */
export function updateMerkleRoot(
  config: AccessConfig,
  newRoot: Buffer,
): AccessConfig {
  return {
    ...config,
    merkleRoot: newRoot,
  };
}

/**
 * Create an open access configuration.
 */
export function createOpenConfig(): AccessConfig {
  return {
    mode: AccessMode.Open,
    merkleRoot: null,
    addresses: new Set(),
  };
}

/**
 * Create a whitelist configuration.
 */
export function createWhitelistConfig(
  addresses?: PublicKey[],
  useMerkle?: boolean,
): AccessConfig {
  const addressSet = new Set(addresses?.map((a) => a.toBase58()) ?? []);
  const merkleRoot =
    useMerkle && addresses && addresses.length > 0
      ? generateMerkleRoot(addresses)
      : null;

  return {
    mode: AccessMode.Whitelist,
    merkleRoot,
    addresses: useMerkle ? new Set() : addressSet,
  };
}

/**
 * Create a blacklist configuration.
 */
export function createBlacklistConfig(addresses?: PublicKey[]): AccessConfig {
  return {
    mode: AccessMode.Blacklist,
    merkleRoot: null,
    addresses: new Set(addresses?.map((a) => a.toBase58()) ?? []),
  };
}

/**
 * Check if address is in list (without merkle).
 */
export function isInList(config: AccessConfig, address: PublicKey): boolean {
  return config.addresses.has(address.toBase58());
}

/**
 * Get number of addresses in list.
 */
export function getListSize(config: AccessConfig): number {
  return config.addresses.size;
}

/**
 * Get all addresses in list.
 */
export function getListAddresses(config: AccessConfig): string[] {
  return Array.from(config.addresses);
}
