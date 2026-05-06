/** Tests for nav-oracle PDA derivation: NavAccount per-pool address + program ID */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  NAV_ACCOUNT_SEED,
  NAV_ORACLE_PROGRAM_ID,
  getNavAccountAddress,
} from "../src/nav-oracle-pda";

describe("SDK Nav Oracle PDA Module", () => {
  const POOL_A = new PublicKey("So11111111111111111111111111111111111111112");
  const POOL_B = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const POOL_C = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  );
  const ALT_PROGRAM_ID = new PublicKey(
    "SVS1111111111111111111111111111111111111111",
  );

  describe("Constants", () => {
    it("NAV_ACCOUNT_SEED matches Rust SEED_PREFIX (b\"nav_oracle\")", () => {
      expect(NAV_ACCOUNT_SEED.toString()).to.equal("nav_oracle");
    });

    it("NAV_ORACLE_PROGRAM_ID matches the deployed declare_id", () => {
      expect(NAV_ORACLE_PROGRAM_ID.toBase58()).to.equal(
        "7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7",
      );
    });

    it("NAV_ORACLE_PROGRAM_ID is a PublicKey", () => {
      expect(NAV_ORACLE_PROGRAM_ID).to.be.instanceOf(PublicKey);
    });
  });

  describe("getNavAccountAddress", () => {
    it("derives a deterministic address for the same pool", () => {
      const [pda1, bump1] = getNavAccountAddress(POOL_A);
      const [pda2, bump2] = getNavAccountAddress(POOL_A);

      expect(pda1.equals(pda2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("returns a PublicKey + numeric bump", () => {
      const [pda, bump] = getNavAccountAddress(POOL_A);

      expect(pda).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
      expect(bump).to.be.greaterThanOrEqual(0);
      expect(bump).to.be.lessThanOrEqual(255);
    });

    it("different pools produce different PDAs", () => {
      const [pdaA] = getNavAccountAddress(POOL_A);
      const [pdaB] = getNavAccountAddress(POOL_B);
      const [pdaC] = getNavAccountAddress(POOL_C);

      expect(pdaA.equals(pdaB)).to.be.false;
      expect(pdaA.equals(pdaC)).to.be.false;
      expect(pdaB.equals(pdaC)).to.be.false;
    });

    it("defaults to NAV_ORACLE_PROGRAM_ID when programId is omitted", () => {
      const [pdaDefault] = getNavAccountAddress(POOL_A);
      const [pdaExplicit] = getNavAccountAddress(POOL_A, NAV_ORACLE_PROGRAM_ID);

      expect(pdaDefault.equals(pdaExplicit)).to.be.true;
    });

    it("different program IDs produce different PDAs for the same pool", () => {
      const [pdaDefault] = getNavAccountAddress(POOL_A);
      const [pdaAlt] = getNavAccountAddress(POOL_A, ALT_PROGRAM_ID);

      expect(pdaDefault.equals(pdaAlt)).to.be.false;
    });

    it("matches manual findProgramAddressSync derivation", () => {
      const [expectedPda, expectedBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("nav_oracle"), POOL_A.toBuffer()],
        NAV_ORACLE_PROGRAM_ID,
      );
      const [pda, bump] = getNavAccountAddress(POOL_A);

      expect(pda.equals(expectedPda)).to.be.true;
      expect(bump).to.equal(expectedBump);
    });
  });
});
