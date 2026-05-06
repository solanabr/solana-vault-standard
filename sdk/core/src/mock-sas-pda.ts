import { PublicKey } from "@solana/web3.js";

/**
 * mock-sas program ID. The mock-sas program implements the on-chain
 * Attestation account format used by SVS-11 and other SVS variants that
 * require KYC/accreditation checks. Production deployments swap this out
 * for a SAS-compatible attestation provider (e.g. Civic, Solana Attestation
 * Service) that writes accounts in the same byte layout.
 */
export const MOCK_SAS_PROGRAM_ID = new PublicKey(
  "GTTMWDHTZibyEpqNRr33RnBhgms262U6qHaGrjoHqEXg",
);

/**
 * Seed prefix for mock-sas Attestation PDAs.
 *
 * On-chain layout: `[b"attestation", subject, issuer, &[attestation_type]]`.
 */
export const ATTESTATION_SEED = Buffer.from("attestation");

/**
 * Derive an Attestation PDA from (subject, issuer, attestation_type).
 *
 * Mirrors mock-sas's `CreateAttestation` accounts struct seeds.
 *
 * @param subject - The wallet being attested
 * @param issuer - The attester identity (program authority)
 * @param attestationType - Type discriminator (0 = KYC, 1 = Accredited, etc.)
 */
export function getMockSasAttestationAddress(
  subject: PublicKey,
  issuer: PublicKey,
  attestationType: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      ATTESTATION_SEED,
      subject.toBuffer(),
      issuer.toBuffer(),
      Buffer.from([attestationType]),
    ],
    MOCK_SAS_PROGRAM_ID,
  );
}
