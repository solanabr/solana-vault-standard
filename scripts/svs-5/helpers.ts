/**
 * SVS-5 helpers — re-exports shared utilities with SVS-5 types.
 * Note: SVS-5 uses "stream_vault" seed (not "vault") for the vault PDA.
 */

import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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

/** Create ATA for shares token (idempotent — safe to call if ATA already exists) */
export function createSharesAtaIx(
  payer: PublicKey,
  owner: PublicKey,
  sharesMint: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    getSharesAtaAddress(owner, sharesMint),
    owner,
    sharesMint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/** Derive the shares ATA address for a given owner */
function getSharesAtaAddress(owner: PublicKey, sharesMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(sharesMint, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}
