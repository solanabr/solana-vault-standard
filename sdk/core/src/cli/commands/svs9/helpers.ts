/** Shared helpers for SVS-9 CLI commands */

import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { AllocatorVaultClient } from "../../../svs9";
import { loadProgramForVariant } from "../../utils";

export interface LoadedAllocatorContext {
  program: Program;
  client: AllocatorVaultClient;
  vaultId: BN;
  assetMint: PublicKey;
}

export interface ChildVaultAccounts {
  childAssetMint: PublicKey;
  childSharesMint: PublicKey;
  childAssetVault: PublicKey;
}

/**
 * Load the SVS-9 program + SDK client for a vault identifier.
 */
export async function loadAllocatorContext(
  provider: AnchorProvider,
  assetMintArg: string,
  vaultIdArg: string,
): Promise<LoadedAllocatorContext> {
  const program = loadProgramForVariant(provider, "svs-9");
  const vaultId = new BN(vaultIdArg);
  const assetMint = new PublicKey(assetMintArg);
  const client = await AllocatorVaultClient.load(program, assetMint, vaultId);

  return {
    program,
    client,
    vaultId,
    assetMint,
  };
}

/**
 * Infer child vault asset mint, shares mint, and asset vault from account data.
 *
 * The live/stored and public/confidential variants all keep these fields in the
 * same order even when later fields diverge.
 */
export async function inferChildVaultAccounts(
  provider: AnchorProvider,
  childVault: PublicKey,
): Promise<ChildVaultAccounts> {
  const accountInfo = await provider.connection.getAccountInfo(childVault);
  if (!accountInfo) {
    throw new Error(`Child vault account not found: ${childVault.toBase58()}`);
  }

  const data = accountInfo.data;
  const supportedLengths = [197, 201, 211, 246, 254];
  if (!supportedLengths.includes(data.length)) {
    throw new Error(`Unsupported child vault layout: ${data.length} bytes`);
  }

  return {
    childAssetMint: new PublicKey(data.subarray(40, 72)),
    childSharesMint: new PublicKey(data.subarray(72, 104)),
    childAssetVault: new PublicKey(data.subarray(104, 136)),
  };
}
