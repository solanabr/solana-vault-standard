/** Tests for the off-chain canonical attestation reader (sdk/core/src/attestation.ts). */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  ATTESTATION_VERSION,
  ATTESTATION_ACCOUNT_LEN,
  DISCRIMINATOR_LEN,
  SUBJECT_OFFSET,
  ISSUER_OFFSET,
  ATTESTATION_TYPE_OFFSET,
  ISSUED_AT_OFFSET,
  EXPIRES_AT_OFFSET,
  REVOKED_OFFSET,
  BUMP_OFFSET,
  KYC_RISK_TIER_OFFSET,
  decodeAttestation,
  verifyAttestation,
  deriveAttestationAddress,
  AttestationError,
  type AttestationErrorCode,
} from "../src/attestation";

const PROGRAM = new PublicKey("GTTMWDHTZibyEpqNRr33RnBhgms262U6qHaGrjoHqEXg");
const SUBJECT = new PublicKey("So11111111111111111111111111111111111111112");
const ISSUER = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TYPE = 0;

interface Fields {
  version?: number;
  subject?: PublicKey;
  issuer?: PublicKey;
  attestationType?: number;
  issuedAt?: bigint;
  expiresAt?: bigint;
  revoked?: boolean;
  bump?: number;
  kycRiskTier?: number;
}

/** Build a canonical 130-byte attestation account at fixed offsets. */
function buildAccount(f: Fields = {}): Buffer {
  const buf = Buffer.alloc(ATTESTATION_ACCOUNT_LEN); // disc + payload, zeroed
  const at = (payloadOffset: number) => DISCRIMINATOR_LEN + payloadOffset;
  buf[at(0)] = f.version ?? ATTESTATION_VERSION;
  (f.subject ?? SUBJECT).toBuffer().copy(buf, at(SUBJECT_OFFSET));
  (f.issuer ?? ISSUER).toBuffer().copy(buf, at(ISSUER_OFFSET));
  buf[at(ATTESTATION_TYPE_OFFSET)] = f.attestationType ?? TYPE;
  buf.writeBigInt64LE(f.issuedAt ?? 1_000n, at(ISSUED_AT_OFFSET));
  buf.writeBigInt64LE(f.expiresAt ?? 9_000_000_000n, at(EXPIRES_AT_OFFSET));
  buf[at(REVOKED_OFFSET)] = f.revoked ? 1 : 0;
  buf[at(BUMP_OFFSET)] = f.bump ?? 255;
  buf[at(KYC_RISK_TIER_OFFSET)] = f.kycRiskTier ?? 3;
  return buf;
}

function expectCode(fn: () => void, code: AttestationErrorCode): void {
  try {
    fn();
    expect.fail(`expected AttestationError(${code})`);
  } catch (e) {
    expect(e).to.be.instanceOf(AttestationError);
    expect((e as AttestationError).code).to.equal(code);
  }
}

describe("SDK attestation reader", () => {
  describe("decodeAttestation", () => {
    it("round-trips every field at its canonical offset", () => {
      const att = decodeAttestation(
        buildAccount({
          issuedAt: 1_700_000_000n,
          expiresAt: 1_800_000_000n,
          bump: 254,
          kycRiskTier: 2,
        }),
      );
      expect(att.version).to.equal(ATTESTATION_VERSION);
      expect(att.subject.equals(SUBJECT)).to.be.true;
      expect(att.issuer.equals(ISSUER)).to.be.true;
      expect(att.attestationType).to.equal(TYPE);
      expect(att.issuedAt).to.equal(1_700_000_000n);
      expect(att.expiresAt).to.equal(1_800_000_000n);
      expect(att.revoked).to.be.false;
      expect(att.bump).to.equal(254);
      expect(att.kycRiskTier).to.equal(2);
    });

    it("rejects a buffer shorter than the account length", () => {
      expectCode(() => decodeAttestation(Buffer.alloc(64)), "Malformed");
    });
  });

  describe("deriveAttestationAddress", () => {
    it('matches the canonical [b"attestation", subject, issuer, type] seeds', () => {
      const [pda] = deriveAttestationAddress(SUBJECT, ISSUER, TYPE, PROGRAM);
      const [expected] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("attestation"),
          SUBJECT.toBuffer(),
          ISSUER.toBuffer(),
          Buffer.from([TYPE]),
        ],
        PROGRAM,
      );
      expect(pda.equals(expected)).to.be.true;
    });
  });

  describe("verifyAttestation", () => {
    const [account] = deriveAttestationAddress(SUBJECT, ISSUER, TYPE, PROGRAM);
    const base = {
      account,
      owner: PROGRAM,
      attestationProgram: PROGRAM,
      subject: SUBJECT,
      expectedIssuer: ISSUER,
      expectedType: TYPE,
      now: 1_700_000_000,
    };

    it("accepts a valid attestation and returns the decoded payload", () => {
      const att = verifyAttestation({ ...base, data: buildAccount() });
      expect(att.subject.equals(SUBJECT)).to.be.true;
    });

    it("rejects wrong owner before parsing", () => {
      expectCode(
        () =>
          verifyAttestation({
            ...base,
            owner: SUBJECT, // not the attestation program
            data: buildAccount(),
          }),
        "WrongOwner",
      );
    });

    it("rejects a mismatched version byte", () => {
      expectCode(
        () =>
          verifyAttestation({ ...base, data: buildAccount({ version: 2 }) }),
        "WrongVersion",
      );
    });

    it("rejects a revoked attestation", () => {
      expectCode(
        () =>
          verifyAttestation({ ...base, data: buildAccount({ revoked: true }) }),
        "Revoked",
      );
    });

    it("rejects an expired attestation (expires_at <= now)", () => {
      expectCode(
        () =>
          verifyAttestation({
            ...base,
            data: buildAccount({ expiresAt: 1_600_000_000n }),
          }),
        "Expired",
      );
    });

    it("rejects an issuer that is not the expected trust anchor", () => {
      expectCode(
        () =>
          verifyAttestation({
            ...base,
            data: buildAccount({ issuer: SUBJECT }),
          }),
        "IssuerMismatch",
      );
    });

    it("rejects when the account address is not the canonical PDA", () => {
      expectCode(
        () =>
          verifyAttestation({
            ...base,
            account: ISSUER, // arbitrary non-PDA address
            data: buildAccount(),
          }),
        "PdaMismatch",
      );
    });
  });
});
