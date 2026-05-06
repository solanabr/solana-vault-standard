/**
 * PDA derivation helpers for the `compliance-hook` program.
 *
 * Four account families are derived under the program:
 *   - `MintConfig`            seeds: [b"mint_config", mint]
 *   - `SanctionsList`         seeds: [b"sanctions_list"] (singleton)
 *   - `ExtraAccountMetaList`  seeds: [b"extra-account-metas", mint]
 *   - `FrozenAccount`         seeds: [b"frozen", owner]
 *
 * NOTE: `extra-account-metas` uses HYPHENS (not underscores) — the seed is
 * fixed by the Token-2022 TransferHook spec.
 */
import { PublicKey } from "@solana/web3.js";

/** Seed for per-mint compliance configuration PDA. */
export const MINT_CONFIG_SEED = Buffer.from("mint_config");
/** Seed for the singleton sanctions list PDA. */
export const SANCTIONS_LIST_SEED = Buffer.from("sanctions_list");
/**
 * Seed for the per-mint ExtraAccountMetaList PDA. Hyphenated literal is fixed
 * by the Token-2022 TransferHook interface spec — do NOT change.
 */
export const EXTRA_ACCOUNT_METAS_SEED = Buffer.from("extra-account-metas");
/** Seed for the per-owner global freeze marker PDA. */
export const COMPLIANCE_FROZEN_ACCOUNT_SEED = Buffer.from("frozen");

/** Deployed program ID for the compliance-hook program. */
export const COMPLIANCE_HOOK_PROGRAM_ID = new PublicKey(
  "6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P",
);

/**
 * Derive the per-mint `MintConfig` PDA address.
 *
 * Seeds: `[b"mint_config", mint]`.
 */
export function getMintConfigAddress(
  mint: PublicKey,
  programId: PublicKey = COMPLIANCE_HOOK_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MINT_CONFIG_SEED, mint.toBuffer()],
    programId,
  );
}

/**
 * Derive the singleton `SanctionsList` PDA address.
 *
 * Seeds: `[b"sanctions_list"]`. There is exactly one per program deployment.
 */
export function getSanctionsListAddress(
  programId: PublicKey = COMPLIANCE_HOOK_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SANCTIONS_LIST_SEED],
    programId,
  );
}

/**
 * Derive the per-mint `ExtraAccountMetaList` PDA address.
 *
 * Seeds: `[b"extra-account-metas", mint]`. The hyphenated seed is mandated
 * by the Token-2022 TransferHook spec.
 */
export function getExtraAccountMetaListAddress(
  mint: PublicKey,
  programId: PublicKey = COMPLIANCE_HOOK_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [EXTRA_ACCOUNT_METAS_SEED, mint.toBuffer()],
    programId,
  );
}

/**
 * Derive a global per-owner `FrozenAccount` PDA.
 *
 * Seeds: `[b"frozen", owner]`. Existence of this PDA causes the hook to
 * reject transfers where `owner` is either the source or destination ATA owner.
 */
export function getComplianceFrozenAccountAddress(
  owner: PublicKey,
  programId: PublicKey = COMPLIANCE_HOOK_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [COMPLIANCE_FROZEN_ACCOUNT_SEED, owner.toBuffer()],
    programId,
  );
}

/**
 * Convenience helper that derives all three per-mint compliance PDAs
 * (`mintConfig`, `extraAccountMetaList`, `sanctionsList`) in one call.
 */
export function deriveComplianceHookAddresses(
  mint: PublicKey,
  programId: PublicKey = COMPLIANCE_HOOK_PROGRAM_ID,
): {
  mintConfig: PublicKey;
  mintConfigBump: number;
  extraAccountMetaList: PublicKey;
  extraAccountMetaListBump: number;
  sanctionsList: PublicKey;
  sanctionsListBump: number;
} {
  const [mintConfig, mintConfigBump] = getMintConfigAddress(mint, programId);
  const [extraAccountMetaList, extraAccountMetaListBump] =
    getExtraAccountMetaListAddress(mint, programId);
  const [sanctionsList, sanctionsListBump] =
    getSanctionsListAddress(programId);

  return {
    mintConfig,
    mintConfigBump,
    extraAccountMetaList,
    extraAccountMetaListBump,
    sanctionsList,
    sanctionsListBump,
  };
}
