/**
 * SVS-9 helpers — re-exports shared utilities with SVS-9 (Allocator Vault) types.
 */

import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Svs9 } from "../../target/types/svs_9";
import {
  setupTest as genericSetupTest,
  type SetupResult as GenericSetupResult,
  RPC_URL,
  ASSET_DECIMALS,
  loadKeypair,
  explorerUrl,
  accountUrl,
  fundAccount,
  fundAccounts,
} from "../shared/common-helpers";

// Re-export all shared utilities
export {
  RPC_URL,
  ASSET_DECIMALS,
  loadKeypair,
  explorerUrl,
  accountUrl,
  fundAccount,
  fundAccounts,
};

export const ALLOCATOR_VAULT_SEED = Buffer.from("allocator_vault");
export const CHILD_ALLOCATION_SEED = Buffer.from("child_allocation");

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs9>;
  programId: PublicKey;
}

export function getAllocatorVaultPDA(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      ALLOCATOR_VAULT_SEED,
      assetMint.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}

export function getChildAllocationPDA(
  programId: PublicKey,
  allocatorVault: PublicKey,
  childVault: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CHILD_ALLOCATION_SEED, allocatorVault.toBuffer(), childVault.toBuffer()],
    programId
  );
}

export async function setupTest(testName: string): Promise<SetupResult> {
  return genericSetupTest<Svs9>(testName, "svs_9" as any);
}
