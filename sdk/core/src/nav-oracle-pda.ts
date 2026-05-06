import { PublicKey } from "@solana/web3.js";

/**
 * Seed used for the per-pool `NavAccount` PDA.
 *
 * Mirrors `NavAccount::SEED_PREFIX` (`b"nav_oracle"`) defined in
 * `programs/nav-oracle/src/state.rs`.
 */
export const NAV_ACCOUNT_SEED = Buffer.from("nav_oracle");

/**
 * Deployed nav-oracle program ID. Matches `declare_id!` in
 * `programs/nav-oracle/src/lib.rs`.
 */
export const NAV_ORACLE_PROGRAM_ID = new PublicKey(
  "7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7",
);

/**
 * Derive the `NavAccount` PDA for a given pool.
 *
 * Seeds: `[NAV_ACCOUNT_SEED, pool.toBuffer()]`.
 *
 * The `pool` is the SVS-11 CreditVault PDA address — one NavAccount per pool.
 */
export function getNavAccountAddress(
  pool: PublicKey,
  programId: PublicKey = NAV_ORACLE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NAV_ACCOUNT_SEED, pool.toBuffer()],
    programId,
  );
}
