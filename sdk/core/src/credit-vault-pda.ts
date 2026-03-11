import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export const CREDIT_VAULT_SEED = Buffer.from("credit_vault");
export const CREDIT_SHARES_MINT_SEED = Buffer.from("shares");
export const REDEMPTION_ESCROW_SEED = Buffer.from("redemption_escrow");
export const INVESTMENT_REQUEST_SEED = Buffer.from("investment_request");
export const REDEMPTION_REQUEST_SEED = Buffer.from("redemption_request");
export const CLAIMABLE_TOKENS_SEED = Buffer.from("claimable_tokens");
export const FROZEN_ACCOUNT_SEED = Buffer.from("frozen_account");

export function getCreditVaultAddress(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
): [PublicKey, number] {
  const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
  return PublicKey.findProgramAddressSync(
    [CREDIT_VAULT_SEED, assetMint.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

export function getCreditSharesMintAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CREDIT_SHARES_MINT_SEED, vault.toBuffer()],
    programId,
  );
}

export function getRedemptionEscrowAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REDEMPTION_ESCROW_SEED, vault.toBuffer()],
    programId,
  );
}

export function getInvestmentRequestAddress(
  programId: PublicKey,
  vault: PublicKey,
  investor: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [INVESTMENT_REQUEST_SEED, vault.toBuffer(), investor.toBuffer()],
    programId,
  );
}

export function getRedemptionRequestAddress(
  programId: PublicKey,
  vault: PublicKey,
  investor: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REDEMPTION_REQUEST_SEED, vault.toBuffer(), investor.toBuffer()],
    programId,
  );
}

export function getClaimableTokensAddress(
  programId: PublicKey,
  vault: PublicKey,
  investor: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CLAIMABLE_TOKENS_SEED, vault.toBuffer(), investor.toBuffer()],
    programId,
  );
}

export function getFrozenAccountAddress(
  programId: PublicKey,
  vault: PublicKey,
  investor: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FROZEN_ACCOUNT_SEED, vault.toBuffer(), investor.toBuffer()],
    programId,
  );
}

export function deriveCreditVaultAddresses(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
): {
  vault: PublicKey;
  vaultBump: number;
  sharesMint: PublicKey;
  sharesMintBump: number;
  redemptionEscrow: PublicKey;
  redemptionEscrowBump: number;
} {
  const [vault, vaultBump] = getCreditVaultAddress(
    programId,
    assetMint,
    vaultId,
  );
  const [sharesMint, sharesMintBump] = getCreditSharesMintAddress(
    programId,
    vault,
  );
  const [redemptionEscrow, redemptionEscrowBump] = getRedemptionEscrowAddress(
    programId,
    vault,
  );

  return {
    vault,
    vaultBump,
    sharesMint,
    sharesMintBump,
    redemptionEscrow,
    redemptionEscrowBump,
  };
}
