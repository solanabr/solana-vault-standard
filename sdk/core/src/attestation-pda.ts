/**
 * Generic Attestation PDA derivation, parameterized by the attestation
 * program ID. Used by SVS-11 + compliance-hook integration to resolve
 * cross-program attestation PDAs without hardcoding a specific
 * attestation provider.
 *
 * On-chain layout (seed convention shared by mock-sas and any
 * compatible attestation provider):
 *
 *   `[b"attestation", subject, issuer, &[attestation_type]]`
 *
 * For the mock-sas-specific helper (which bakes in
 * `MOCK_SAS_PROGRAM_ID`), see `getMockSasAttestationAddress` in
 * `./mock-sas-pda`. Production deployments using a different
 * attestation provider pass that provider's program ID here.
 */
import { PublicKey } from "@solana/web3.js";

/**
 * Seed prefix for Attestation PDAs, matching the canonical layout used
 * by mock-sas and SAS-compatible attestation providers.
 */
export const ATTESTATION_PDA_SEED = Buffer.from("attestation");

/**
 * Derive an Attestation PDA against an arbitrary attestation program.
 *
 * Seeds: `[b"attestation", subject, issuer, &[attestation_type]]`.
 *
 * @param subject - Wallet being attested
 * @param issuer - Attester identity
 * @param attestationType - Type discriminator (0 = KYC, 1 = Accredited, etc.)
 * @param attestationProgramId - The attestation program; must match the
 *   `attestation_program` recorded in compliance-hook's `MintConfig`
 *   when the attestation will be consumed by the hook
 */
export function getAttestationAddress(
  subject: PublicKey,
  issuer: PublicKey,
  attestationType: number,
  attestationProgramId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      ATTESTATION_PDA_SEED,
      subject.toBuffer(),
      issuer.toBuffer(),
      Buffer.from([attestationType]),
    ],
    attestationProgramId,
  );
}
