/**
 * PDA Derivation Module for SVS-11 Credit Markets Vault
 *
 * Program Derived Address helpers for credit vault accounts.
 *
 * Seeds:
 * - CreditVault: ["credit_vault", asset_mint, vault_id (u64 LE)]
 * - Shares Mint: ["shares", vault_pubkey]
 * - Deposit Vault: ["deposit_vault", vault_pubkey]
 * - Redemption Escrow: ["redemption_escrow", vault_pubkey]
 * - Investment Request: ["investment_request", vault_pubkey, investor_pubkey]
 * - Redemption Request: ["redemption_request", vault_pubkey, investor_pubkey]
 * - Claimable Escrow: ["claimable", vault_pubkey, investor_pubkey]
 * - Claimable Tokens: ["claimable_tokens", vault_pubkey, investor_pubkey]
 * - Frozen Account: ["frozen_account", vault_pubkey, investor_pubkey]
 */

import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export const CREDIT_VAULT_SEED = Buffer.from("credit_vault");
export const CREDIT_SHARES_MINT_SEED = Buffer.from("shares");
export const DEPOSIT_VAULT_SEED = Buffer.from("deposit_vault");
export const REDEMPTION_ESCROW_SEED = Buffer.from("redemption_escrow");
export const INVESTMENT_REQUEST_SEED = Buffer.from("investment_request");
export const REDEMPTION_REQUEST_SEED = Buffer.from("redemption_request");
export const CLAIMABLE_SEED = Buffer.from("claimable");
export const CLAIMABLE_TOKENS_SEED = Buffer.from("claimable_tokens");
export const FROZEN_ACCOUNT_SEED = Buffer.from("frozen_account");
export const ATTESTATION_SEED = Buffer.from("attestation");

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

export function getDepositVaultAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DEPOSIT_VAULT_SEED, vault.toBuffer()],
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

export function getClaimableEscrowAddress(
  programId: PublicKey,
  vault: PublicKey,
  investor: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CLAIMABLE_SEED, vault.toBuffer(), investor.toBuffer()],
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
  depositVault: PublicKey;
  depositVaultBump: number;
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
  const [depositVault, depositVaultBump] = getDepositVaultAddress(
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
    depositVault,
    depositVaultBump,
    redemptionEscrow,
    redemptionEscrowBump,
  };
}
