import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export const TRANCHED_VAULT_SEED = Buffer.from("tranched_vault");
export const TRANCHE_SEED = Buffer.from("tranche");
export const TRANCHE_SHARES_MINT_SEED = Buffer.from("shares");

export function getTranchedVaultAddress(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
): [PublicKey, number] {
  const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
  return PublicKey.findProgramAddressSync(
    [TRANCHED_VAULT_SEED, assetMint.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

export function getTrancheAddress(
  programId: PublicKey,
  vault: PublicKey,
  index: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TRANCHE_SEED, vault.toBuffer(), Buffer.from([index])],
    programId,
  );
}

export function getTrancheSharesMintAddress(
  programId: PublicKey,
  vault: PublicKey,
  index: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TRANCHE_SHARES_MINT_SEED, vault.toBuffer(), Buffer.from([index])],
    programId,
  );
}

export function deriveTranchedVaultAddresses(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
) {
  const [vault, vaultBump] = getTranchedVaultAddress(programId, assetMint, vaultId);
  return { vault, vaultBump };
}
