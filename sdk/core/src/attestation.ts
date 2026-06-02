/**
 * Off-chain mirror of the canonical SVS attestation layout
 * (`modules/svs-attestation`). Lets a consumer decode and validate an
 * attestation account written by ANY SAS-compatible issuer (mock-sas, Civic,
 * Solana Attestation Service) WITHOUT that issuer's IDL — it reads raw account
 * bytes by fixed offset, exactly like SVS-11's on-chain cross-program read.
 *
 * Byte-for-byte parity with `modules/svs-attestation/src/{constants,attestation}.rs`.
 * Payload layout (after the 8-byte Anchor discriminator):
 *     0        version          (u8, == ATTESTATION_VERSION)
 *     1..33    subject          (Pubkey)
 *    33..65    issuer           (Pubkey)
 *    65        attestation_type (u8)
 *    66..68    country_code     ([u8; 2])
 *    68..76    issued_at        (i64 LE)
 *    76..84    expires_at       (i64 LE)
 *    84        revoked          (bool)
 *    85        bump             (u8)
 *    86..118   _reserved        ([u8; 32])
 *   118..120   jurisdiction     ([u8; 2])
 *   120        investor_class   (u8)
 *   121        kyc_risk_tier    (u8)
 */
import { PublicKey } from "@solana/web3.js";

// ── Canonical layout constants (payload-relative; mirror constants.rs) ──

export const DISCRIMINATOR_LEN = 8;
/** Current canonical layout version. `verifyAttestation` rejects any other. */
export const ATTESTATION_VERSION = 1;

export const VERSION_OFFSET = 0;
export const SUBJECT_OFFSET = 1;
export const ISSUER_OFFSET = 33;
export const ATTESTATION_TYPE_OFFSET = 65;
export const COUNTRY_CODE_OFFSET = 66;
export const ISSUED_AT_OFFSET = 68;
export const EXPIRES_AT_OFFSET = 76;
export const REVOKED_OFFSET = 84;
export const BUMP_OFFSET = 85;
export const RESERVED_OFFSET = 86;
export const JURISDICTION_OFFSET = 118;
export const INVESTOR_CLASS_OFFSET = 120;
export const KYC_RISK_TIER_OFFSET = 121;

/** Canonical payload length (all fields after the discriminator). */
export const ATTESTATION_PAYLOAD_LEN = 122;
/** Full on-disk account length (discriminator + payload). */
export const ATTESTATION_ACCOUNT_LEN =
  DISCRIMINATOR_LEN + ATTESTATION_PAYLOAD_LEN;

/** Canonical PDA seed prefix: `[b"attestation", subject, issuer, &[type]]`. */
export const ATTESTATION_SEED_PREFIX = Buffer.from("attestation");

/** Discriminable reasons an attestation fails to decode or verify. */
export type AttestationErrorCode =
  | "Malformed"
  | "WrongVersion"
  | "WrongOwner"
  | "SubjectMismatch"
  | "IssuerMismatch"
  | "WrongType"
  | "Revoked"
  | "Expired"
  | "PdaMismatch";

/** Error thrown by {@link decodeAttestation} / {@link verifyAttestation}. */
export class AttestationError extends Error {
  constructor(
    readonly code: AttestationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AttestationError";
  }
}

/** Decoded attestation payload. Mirrors the Rust `Attestation` struct. */
export interface Attestation {
  version: number;
  subject: PublicKey;
  issuer: PublicKey;
  attestationType: number;
  /** ISO-3166 country code, raw 2 bytes (zeros = unset). */
  countryCode: Uint8Array;
  /** Unix seconds; i64 surfaced as bigint to avoid precision loss. */
  issuedAt: bigint;
  expiresAt: bigint;
  revoked: boolean;
  bump: number;
  /** Jurisdiction tag, raw 2 bytes (zeros = no policy). */
  jurisdiction: Uint8Array;
  investorClass: number;
  kycRiskTier: number;
}

/**
 * Derive the canonical attestation PDA for `(subject, issuer, type)` under a
 * given attestation program. Program-agnostic: pass the program that owns the
 * attestation accounts (mock-sas on devnet, a SAS provider in production).
 */
export function deriveAttestationAddress(
  subject: PublicKey,
  issuer: PublicKey,
  attestationType: number,
  attestationProgram: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      ATTESTATION_SEED_PREFIX,
      subject.toBuffer(),
      issuer.toBuffer(),
      Buffer.from([attestationType]),
    ],
    attestationProgram,
  );
}

/**
 * Decode the canonical payload from raw account data, skipping the 8-byte
 * Anchor discriminator. Pure parser — {@link verifyAttestation} enforces the
 * version match, trust anchors, and PDA binding.
 *
 * @throws {AttestationError} `Malformed` if the buffer is shorter than
 *   {@link ATTESTATION_ACCOUNT_LEN}.
 */
export function decodeAttestation(data: Uint8Array): Attestation {
  if (data.length < ATTESTATION_ACCOUNT_LEN) {
    throw new AttestationError(
      "Malformed",
      `account ${data.length} bytes < ${ATTESTATION_ACCOUNT_LEN}`,
    );
  }
  // Buffer over the payload (after the discriminator) so offsets match the
  // payload-relative constants one-to-one.
  const p = Buffer.from(
    data.buffer,
    data.byteOffset + DISCRIMINATOR_LEN,
    ATTESTATION_PAYLOAD_LEN,
  );

  return {
    version: p[VERSION_OFFSET],
    subject: new PublicKey(p.subarray(SUBJECT_OFFSET, SUBJECT_OFFSET + 32)),
    issuer: new PublicKey(p.subarray(ISSUER_OFFSET, ISSUER_OFFSET + 32)),
    attestationType: p[ATTESTATION_TYPE_OFFSET],
    countryCode: Uint8Array.prototype.slice.call(
      p,
      COUNTRY_CODE_OFFSET,
      COUNTRY_CODE_OFFSET + 2,
    ),
    issuedAt: p.readBigInt64LE(ISSUED_AT_OFFSET),
    expiresAt: p.readBigInt64LE(EXPIRES_AT_OFFSET),
    revoked: p[REVOKED_OFFSET] !== 0,
    bump: p[BUMP_OFFSET],
    jurisdiction: Uint8Array.prototype.slice.call(
      p,
      JURISDICTION_OFFSET,
      JURISDICTION_OFFSET + 2,
    ),
    investorClass: p[INVESTOR_CLASS_OFFSET],
    kycRiskTier: p[KYC_RISK_TIER_OFFSET],
  };
}

/** Trust anchors + clock for {@link checkAttestationInvariants}. */
export interface AttestationInvariants {
  subject: PublicKey;
  expectedIssuer: PublicKey;
  expectedType: number;
  /** Current unix timestamp (seconds). */
  now: number | bigint;
}

/**
 * Enforce the universal attestation invariants against the configured trust
 * anchors. Pure — no ownership or PDA inspection (that's {@link verifyAttestation}).
 * Mirrors the Rust `check_invariants`.
 *
 * @throws {AttestationError} on the first failing invariant.
 */
export function checkAttestationInvariants(
  att: Attestation,
  inv: AttestationInvariants,
): void {
  if (!att.subject.equals(inv.subject)) {
    throw new AttestationError("SubjectMismatch");
  }
  if (!att.issuer.equals(inv.expectedIssuer)) {
    throw new AttestationError("IssuerMismatch");
  }
  if (att.attestationType !== inv.expectedType) {
    throw new AttestationError("WrongType");
  }
  if (att.revoked) {
    throw new AttestationError("Revoked");
  }
  // Valid iff expires_at is strictly in the future; non-positive expiry is
  // therefore treated as expired (matches the on-chain check).
  if (att.expiresAt <= BigInt(inv.now)) {
    throw new AttestationError("Expired");
  }
}

/** Inputs for full {@link verifyAttestation}. */
export interface VerifyAttestationParams extends AttestationInvariants {
  /** The attestation account address (for the canonical-PDA binding check). */
  account: PublicKey;
  /** The account's on-chain owner (from `getAccountInfo().owner`). */
  owner: PublicKey;
  /** Raw account data (from `getAccountInfo().data`). */
  data: Uint8Array;
  /** The only program permitted to own the attestation. */
  attestationProgram: PublicKey;
}

/**
 * Full off-chain attestation verification, mirroring the on-chain
 * `verify_attestation`: owner binding → layout decode → version gate →
 * universal invariants → canonical-PDA binding. Returns the parsed
 * {@link Attestation} so callers can additionally read `jurisdiction` /
 * `investorClass` / `kycRiskTier`.
 *
 * @throws {AttestationError} with a discriminable `code` on any failure.
 */
export function verifyAttestation(
  params: VerifyAttestationParams,
): Attestation {
  if (!params.owner.equals(params.attestationProgram)) {
    throw new AttestationError("WrongOwner");
  }

  const att = decodeAttestation(params.data);

  // Layout version gate: reject before trusting any offset-read field.
  if (att.version !== ATTESTATION_VERSION) {
    throw new AttestationError(
      "WrongVersion",
      `version ${att.version} != ${ATTESTATION_VERSION}`,
    );
  }

  checkAttestationInvariants(att, params);

  // Canonical-PDA binding: a forged payload satisfying the field checks would
  // derive a different PDA and fail here.
  const [expectedPda] = deriveAttestationAddress(
    params.subject,
    params.expectedIssuer,
    params.expectedType,
    params.attestationProgram,
  );
  if (!expectedPda.equals(params.account)) {
    throw new AttestationError("PdaMismatch");
  }

  return att;
}
