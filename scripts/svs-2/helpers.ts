/**
 * SVS-2 helpers — stored balance model with sync().
 */

import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Svs2 } from "../../target/types/svs_2";
import {
  setupTest as genericSetupTest,
} from "../shared/common-helpers";

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
  program: Program<Svs2>;
  programId: PublicKey;
}

export async function setupTest(testName: string): Promise<SetupResult> {
  return genericSetupTest<Svs2>(testName, "svs_2");
}

/**
 * Call sync() to update stored total_assets to actual vault balance.
 * SVS-2 specific — SVS-1 doesn't have this instruction.
 */
export async function syncVault(
  program: Program<Svs2>,
  authority: Keypair,
  vault: PublicKey,
  assetVault: PublicKey,
  signers?: Keypair[],
): Promise<string> {
  const builder = program.methods
    .sync()
    .accountsStrict({ authority: authority.publicKey, vault, assetVault });

  if (signers && signers.length > 0) {
    builder.signers(signers);
  }

  return builder.rpc();
}
