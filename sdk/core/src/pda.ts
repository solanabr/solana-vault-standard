import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export const VAULT_SEED = Buffer.from("vault");
export const SHARES_MINT_SEED = Buffer.from("shares");

/**
 * Derive the vault PDA address
 */
export function getVaultAddress(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
): [PublicKey, number] {
  const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, assetMint.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

/**
 * Derive the shares mint PDA address
 */
export function getSharesMintAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SHARES_MINT_SEED, vault.toBuffer()],
    programId,
  );
}

/**
 * Derive all vault-related addresses at once
 */
export function deriveVaultAddresses(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
): {
  vault: PublicKey;
  vaultBump: number;
  sharesMint: PublicKey;
  sharesMintBump: number;
} {
  const [vault, vaultBump] = getVaultAddress(programId, assetMint, vaultId);
  const [sharesMint, sharesMintBump] = getSharesMintAddress(programId, vault);

  return {
    vault,
    vaultBump,
    sharesMint,
    sharesMintBump,
  };
}
