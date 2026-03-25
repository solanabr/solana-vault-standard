/**
 * SVS-9 helpers — re-exports shared utilities with SVS-9 (Allocator Vault) types.
 */

import { Program, BN, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { Svs1 } from "../../target/types/svs_1";
import { Svs9 } from "../../target/types/svs_9";
import {
  setupTest as genericSetupTest,
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

export interface MultiProgramSetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  svs9Program: Program<Svs9>;
  svs9ProgramId: PublicKey;
  svs1Program: Program<Svs1>;
  svs1ProgramId: PublicKey;
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
  return genericSetupTest<Svs9>(testName, "svs_9");
}

function loadProgramFromIdl<T extends Idl>(
  provider: anchor.AnchorProvider,
  svsVariant: string
): { program: Program<T>; programId: PublicKey } {
  const idlPath = path.join(__dirname, `../../target/idl/${svsVariant}.json`);
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const programId = new PublicKey(idl.address);
  const program = new Program(idl, provider) as unknown as Program<T>;

  return { program, programId };
}

export async function setupAllocatorWithChildPrograms(
  testName: string
): Promise<MultiProgramSetupResult> {
  const svs9 = await genericSetupTest<Svs9>(testName, "svs_9");
  const svs1 = loadProgramFromIdl<Svs1>(svs9.provider, "svs_1");

  return {
    connection: svs9.connection,
    payer: svs9.payer,
    provider: svs9.provider,
    svs9Program: svs9.program,
    svs9ProgramId: svs9.programId,
    svs1Program: svs1.program,
    svs1ProgramId: svs1.programId,
  };
}
