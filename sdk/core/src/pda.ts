/**
 * PDA Derivation Module
 *
 * Program Derived Address helpers for vault accounts.
 *
 * Seeds:
 * - Vault: ["vault", asset_mint, vault_id (u64 LE)]
 * - Async Vault: ["async_vault", asset_mint, vault_id (u64 LE)]
 * - Shares Mint: ["shares", vault_pubkey]
 * - Share Escrow: ["share_escrow", vault_pubkey]
 * - Deposit Request: ["deposit_request", vault_pubkey, owner_pubkey]
 * - Redeem Request: ["redeem_request", vault_pubkey, owner_pubkey]
 * - Claimable Escrow: ["claimable", vault_pubkey, owner_pubkey]
 * - Operator Approval: ["operator_approval", vault_pubkey, owner_pubkey, operator_pubkey]
 *
 * @example
 * ```ts
 * import { deriveVaultAddresses, getVaultAddress } from "./pda";
 *
 * // Get all vault addresses at once
 * const { vault, sharesMint } = deriveVaultAddresses(programId, assetMint, 1);
 *
 * // Or derive individually
 * const [vault, bump] = getVaultAddress(programId, assetMint, 1);
 * ```
 */

import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

/** Seed for vault PDA derivation */
export const VAULT_SEED = Buffer.from("vault");
/** Seed for async vault PDA derivation */
export const ASYNC_VAULT_SEED = Buffer.from("async_vault");
/** Seed for shares mint PDA derivation */
export const SHARES_MINT_SEED = Buffer.from("shares");
/** Seed for async share escrow PDA derivation */
export const SHARE_ESCROW_SEED = Buffer.from("share_escrow");
/** Seed for deposit request PDA derivation */
export const DEPOSIT_REQUEST_SEED = Buffer.from("deposit_request");
/** Seed for redeem request PDA derivation */
export const REDEEM_REQUEST_SEED = Buffer.from("redeem_request");
/** Seed for claimable escrow PDA derivation */
export const CLAIMABLE_SEED = Buffer.from("claimable");
/** Seed for operator approval PDA derivation */
export const OPERATOR_APPROVAL_SEED = Buffer.from("operator_approval");

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
 * Derive the async vault PDA address
 */
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
 * Derive the async share escrow PDA address
 */
export function getShareEscrowAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SHARE_ESCROW_SEED, vault.toBuffer()],
    programId,
  );
}

/**
 * Derive the deposit request PDA address
 */
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

/**
 * Derive the redeem request PDA address
 */
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

/**
 * Derive the claimable escrow PDA address
 */
export function getClaimableEscrowAddress(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CLAIMABLE_SEED, vault.toBuffer(), owner.toBuffer()],
    programId,
  );
}

/**
 * Derive the operator approval PDA address
 */
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

/**
 * Derive all async vault-related addresses at once
 */
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
  const [vault, vaultBump] = getAsyncVaultAddress(programId, assetMint, vaultId);
  const [sharesMint, sharesMintBump] = getSharesMintAddress(programId, vault);
  const [shareEscrow, shareEscrowBump] = getShareEscrowAddress(programId, vault);

  return {
    vault,
    vaultBump,
    sharesMint,
    sharesMintBump,
    shareEscrow,
    shareEscrowBump,
  };
}
