import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const VAULT_SEED = Buffer.from("confidential_stream_vault");
export const SHARES_MINT_SEED = Buffer.from("shares");

// ── Module PDA seeds ──
export const FEE_CONFIG_SEED = Buffer.from("fee_config");
export const CAP_CONFIG_SEED = Buffer.from("cap_config");
export const USER_DEPOSIT_SEED = Buffer.from("user_deposit");
export const LOCK_CONFIG_SEED = Buffer.from("lock_config");
export const SHARE_LOCK_SEED = Buffer.from("share_lock");
export const ACCESS_CONFIG_SEED = Buffer.from("access_config");
export const FROZEN_SEED = Buffer.from("frozen");
export const REWARD_CONFIG_SEED = Buffer.from("reward_config");
export const USER_REWARD_SEED = Buffer.from("user_reward");

/** Derive the ConfidentialStreamVault PDA. */
export function deriveVaultAddress(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

/** Derive the shares mint PDA (Token-2022 with CT extension). */
export function deriveSharesMintAddress(
  programId: PublicKey,
  vault: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SHARES_MINT_SEED, vault.toBuffer()],
    programId
  );
}

/** Derive all vault-level module config PDAs at once. */
export function deriveModuleAddresses(programId: PublicKey, vault: PublicKey) {
  const derive = (seed: Buffer) =>
    PublicKey.findProgramAddressSync([seed, vault.toBuffer()], programId)[0];

  return {
    feeConfig: derive(FEE_CONFIG_SEED),
    capConfig: derive(CAP_CONFIG_SEED),
    lockConfig: derive(LOCK_CONFIG_SEED),
    accessConfig: derive(ACCESS_CONFIG_SEED),
  };
}

/** Derive all user-specific module PDAs. */
export function deriveUserModuleAddresses(
  programId: PublicKey,
  vault: PublicKey,
  user: PublicKey
) {
  const derive = (seed: Buffer) =>
    PublicKey.findProgramAddressSync(
      [seed, vault.toBuffer(), user.toBuffer()],
      programId
    )[0];

  return {
    userDeposit: derive(USER_DEPOSIT_SEED),
    shareLock: derive(SHARE_LOCK_SEED),
    frozenAccount: derive(FROZEN_SEED),
  };
}

/** Derive reward module PDAs. */
export function deriveRewardModuleAddresses(
  programId: PublicKey,
  vault: PublicKey,
  rewardMint: PublicKey,
  user: PublicKey
) {
  return {
    rewardConfig: PublicKey.findProgramAddressSync(
      [REWARD_CONFIG_SEED, vault.toBuffer(), rewardMint.toBuffer()],
      programId
    )[0],
    userReward: PublicKey.findProgramAddressSync(
      [
        USER_REWARD_SEED,
        vault.toBuffer(),
        rewardMint.toBuffer(),
        user.toBuffer(),
      ],
      programId
    )[0],
  };
}
