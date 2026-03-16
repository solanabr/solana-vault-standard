/**
 * SVS-5 helpers — re-exports shared utilities with SVS-5 types.
 * Note: SVS-5 uses "stream_vault" seed (not "vault") for the vault PDA.
 */

import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Svs5 } from "../../target/types/svs_5";
import {
  setupTest as genericSetupTest,
  type SetupResult as GenericSetupResult,
} from "../shared/common-helpers";

// Re-export shared utilities (except getVaultPDA which we override)
export {
  RPC_URL,
  ASSET_DECIMALS,
  SHARE_DECIMALS,
  loadKeypair,
  getSharesMintPDA,
  explorerUrl,
  accountUrl,
  fundAccount,
  fundAccounts,
} from "../shared/common-helpers";

/** SVS-5 vault PDA uses "stream_vault" seed instead of "vault" */
export function getVaultPDA(programId: PublicKey, assetMint: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stream_vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs5>;
  programId: PublicKey;
}

export async function setupTest(testName: string): Promise<SetupResult> {
  return genericSetupTest<Svs5>(testName, "svs_5");
}
