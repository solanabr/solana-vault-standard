/**
 * SVS-7 helpers — re-exports shared utilities with SVS-7 types.
 *
 * SVS-7 is a native SOL vault. Key differences from SVS-1:
 * - No asset_mint — asset is always native SOL (NATIVE_MINT)
 * - PDA seeds: ["sol_vault", vaultId.to_le_bytes()]
 * - Vault account type: solVault
 */

import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { Svs7 } from "../../target/types/svs_7";
import {
  setupTest as genericSetupTest,
  type SetupResult as GenericSetupResult,
} from "../shared/common-helpers";

// Re-export shared utilities that are valid for SVS-7
export {
  RPC_URL,
  loadKeypair,
  getSharesMintPDA,
  explorerUrl,
  accountUrl,
  fundAccount,
  fundAccounts,
} from "../shared/common-helpers";

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs7>;
  programId: PublicKey;
}

/**
 * Derive the SolVault PDA.
 * Seeds: ["sol_vault", vaultId.toArrayLike(Buffer, "le", 8)]
 * Note: NO asset_mint in seeds — asset is always native SOL.
 */
export function getSolVaultPDA(programId: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), vaultId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

export async function setupSvs7Test(testName: string): Promise<SetupResult> {
  return genericSetupTest<Svs7>(testName, "svs_7");
}
