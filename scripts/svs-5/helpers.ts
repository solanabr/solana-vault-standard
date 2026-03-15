/**
 * SVS-5 helpers — re-exports shared utilities with SVS-5 types.
 */

import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Svs5 } from "../../target/types/svs_5";
import {
  setupTest as genericSetupTest,
  type SetupResult as GenericSetupResult,
} from "../shared/common-helpers";

// Re-export all shared utilities
export {
  RPC_URL,
  ASSET_DECIMALS,
  SHARE_DECIMALS,
  loadKeypair,
  getVaultPDA,
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
  program: Program<Svs5>;
  programId: PublicKey;
}

export async function setupTest(testName: string): Promise<SetupResult> {
  return genericSetupTest<Svs5>(testName, "svs_5");
}
