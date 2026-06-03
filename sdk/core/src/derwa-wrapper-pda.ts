/**
 * PDA helpers for the derwa-wrapper program (cPOOL <-> dePOOL 1:1 wrap/unwrap).
 *
 * Seed bytes match `programs/derwa-wrapper/src/state.rs` (`WrapperConfig::SEED_PREFIX`)
 * and the inline `b"wrapper_signer"` literal used in `wrap.rs` / `unwrap.rs`.
 */

import { PublicKey } from "@solana/web3.js";

/** Program ID for the deployed derwa-wrapper program. */
export const DERWA_WRAPPER_PROGRAM_ID = new PublicKey(
  "8zf7pTE29kmMHoGJCbKP6QRre9RPEPboPad7X3dGutsH",
);

/** Seed prefix for the per-pool WrapperConfig PDA — matches `WrapperConfig::SEED_PREFIX`. */
export const WRAPPER_CONFIG_SEED = Buffer.from("wrapper_config");

/**
 * Seed prefix for the wrapper signer PDA. This PDA owns the locked cPOOL ATA
 * AND acts as the dePOOL mint authority.
 */
export const WRAPPER_SIGNER_SEED = Buffer.from("wrapper_signer");

/**
 * Derive the WrapperConfig PDA address.
 *
 * Seeds: ["wrapper_config", pool]
 *
 * The on-chain seed is just `(WRAPPER_CONFIG_SEED, pool)` — `derwaMint` is
 * accepted for forward-compatibility / call-site clarity but is intentionally
 * unused. Mints are validated by the `WrapperConfig` mint constraints in `wrap`
 * and `unwrap`, not by the PDA seed.
 */
export function getWrapperConfigAddress(
  pool: PublicKey,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _derwaMint?: PublicKey,
  programId: PublicKey = DERWA_WRAPPER_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WRAPPER_CONFIG_SEED, pool.toBuffer()],
    programId,
  );
}

/**
 * Derive the wrapper signer PDA address.
 *
 * Seeds: ["wrapper_signer", pool]
 *
 * Note: in the Rust source the seed reads `wrapper_config.pool` (the pool key
 * stored on the loaded WrapperConfig). Off-chain derivation only needs the pool
 * key directly. This helper takes the pool to mirror that — pass
 * `wrapperConfig.pool` to derive the signer for an existing config.
 */
export function getWrapperSignerAddress(
  pool: PublicKey,
  programId: PublicKey = DERWA_WRAPPER_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WRAPPER_SIGNER_SEED, pool.toBuffer()],
    programId,
  );
}

/**
 * Convenience: derive both wrapper PDAs from the pool key.
 */
export function deriveWrapperAddresses(
  pool: PublicKey,
  programId: PublicKey = DERWA_WRAPPER_PROGRAM_ID,
): {
  wrapperConfig: PublicKey;
  wrapperConfigBump: number;
  wrapperSigner: PublicKey;
  wrapperSignerBump: number;
} {
  const [wrapperConfig, wrapperConfigBump] = getWrapperConfigAddress(
    pool,
    undefined,
    programId,
  );
  const [wrapperSigner, wrapperSignerBump] = getWrapperSignerAddress(
    pool,
    programId,
  );
  return {
    wrapperConfig,
    wrapperConfigBump,
    wrapperSigner,
    wrapperSignerBump,
  };
}
