/**
 * SVS-8 helpers — multi-asset vault PDA derivation and test setup.
 *
 * SVS-8 uses "multi_vault" seed (not "vault") and has per-asset PDAs.
 */

import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Svs8 } from "../../target/types/svs_8";
import {
  setupTest as genericSetupTest,
  type SetupResult as GenericSetupResult,
} from "../shared/common-helpers";

export {
  RPC_URL,
  ASSET_DECIMALS,
  SHARE_DECIMALS,
  loadKeypair,
  explorerUrl,
  accountUrl,
  fundAccount,
  fundAccounts,
} from "../shared/common-helpers";

// SVS-8 seeds
const VAULT_SEED = Buffer.from("multi_vault");
const SHARES_MINT_SEED = Buffer.from("shares");
const ASSET_ENTRY_SEED = Buffer.from("asset_entry");

export function getVaultPDA(programId: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, vaultId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

export function getSharesMintPDA(programId: PublicKey, vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SHARES_MINT_SEED, vault.toBuffer()],
    programId
  );
}

export function getAssetEntryPDA(
  programId: PublicKey,
  vault: PublicKey,
  assetMint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ASSET_ENTRY_SEED, vault.toBuffer(), assetMint.toBuffer()],
    programId
  );
}

export function getAssetVaultATA(
  assetMint: PublicKey,
  vault: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): PublicKey {
  return getAssociatedTokenAddressSync(
    assetMint,
    vault,
    true,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

/** Build remaining_accounts for deposit_single / views: [entry, vault, oracle] x N */
export function oracleRemainingAccounts(
  entries: { entry: PublicKey; vault: PublicKey; oracle: PublicKey }[]
) {
  return entries.flatMap((e) => [
    { pubkey: e.entry, isSigner: false, isWritable: false },
    { pubkey: e.vault, isSigner: false, isWritable: false },
    { pubkey: e.oracle, isSigner: false, isWritable: false },
  ]);
}

/** Build remaining_accounts for update_weights: [entry] x N */
export function weightRemainingAccounts(entries: PublicKey[]) {
  return entries.map((e) => ({ pubkey: e, isSigner: false, isWritable: true }));
}

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs8>;
  programId: PublicKey;
}

export async function setupTest(testName: string): Promise<SetupResult> {
  return genericSetupTest<Svs8>(testName, "svs_8" as any);
}
