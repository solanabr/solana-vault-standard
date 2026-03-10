import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export const ASYNC_VAULT_SEED = Buffer.from("vault");
export const ASYNC_SHARES_MINT_SEED = Buffer.from("shares");
export const SHARE_ESCROW_SEED = Buffer.from("share_escrow");
export const DEPOSIT_REQUEST_SEED = Buffer.from("deposit_request");
export const REDEEM_REQUEST_SEED = Buffer.from("redeem_request");
export const CLAIMABLE_TOKENS_SEED = Buffer.from("claimable_tokens");
export const OPERATOR_APPROVAL_SEED = Buffer.from("operator_approval");

export function getAsyncVaultAddress(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
): [PublicKey, number] {
  const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
  return PublicKey.findProgramAddressSync(
    [ASYNC_VAULT_SEED, assetMint.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

export function getAsyncSharesMintAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ASYNC_SHARES_MINT_SEED, vault.toBuffer()],
    programId,
  );
}

export function getShareEscrowAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SHARE_ESCROW_SEED, vault.toBuffer()],
    programId,
  );
}

export function getDepositRequestAddress(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DEPOSIT_REQUEST_SEED, vault.toBuffer(), owner.toBuffer()],
    programId,
  );
}

export function getRedeemRequestAddress(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REDEEM_REQUEST_SEED, vault.toBuffer(), owner.toBuffer()],
    programId,
  );
}

export function getClaimableTokensAddress(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CLAIMABLE_TOKENS_SEED, vault.toBuffer(), owner.toBuffer()],
    programId,
  );
}

export function getOperatorApprovalAddress(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
  operator: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      OPERATOR_APPROVAL_SEED,
      vault.toBuffer(),
      owner.toBuffer(),
      operator.toBuffer(),
    ],
    programId,
  );
}

export function deriveAsyncVaultAddresses(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
): {
  vault: PublicKey;
  vaultBump: number;
  sharesMint: PublicKey;
  sharesMintBump: number;
  shareEscrow: PublicKey;
  shareEscrowBump: number;
} {
  const [vault, vaultBump] = getAsyncVaultAddress(
    programId,
    assetMint,
    vaultId,
  );
  const [sharesMint, sharesMintBump] = getAsyncSharesMintAddress(
    programId,
    vault,
  );
  const [shareEscrow, shareEscrowBump] = getShareEscrowAddress(
    programId,
    vault,
  );

  return {
    vault,
    vaultBump,
    sharesMint,
    sharesMintBump,
    shareEscrow,
    shareEscrowBump,
  };
}
