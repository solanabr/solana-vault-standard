/** Tests for derwa-wrapper PDA derivation: WrapperConfig + wrapper signer */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  DERWA_WRAPPER_PROGRAM_ID,
  WRAPPER_CONFIG_SEED,
  WRAPPER_SIGNER_SEED,
  getWrapperConfigAddress,
  getWrapperSignerAddress,
  deriveWrapperAddresses,
} from "../src/derwa-wrapper-pda";

describe("SDK DeRwaWrapper PDA Module", () => {
  const POOL = new PublicKey("So11111111111111111111111111111111111111112");
  const OTHER_POOL = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const DERWA_MINT = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  );
  const OTHER_PROGRAM_ID = new PublicKey(
    "SVS1111111111111111111111111111111111111111",
  );

  describe("Constants", () => {
    it("DERWA_WRAPPER_PROGRAM_ID matches deployed program ID", () => {
      expect(DERWA_WRAPPER_PROGRAM_ID.toBase58()).to.equal(
        "8zf7pTE29kmMHoGJCbKP6QRre9RPEPboPad7X3dGutsH",
      );
    });

    it("WRAPPER_CONFIG_SEED matches Rust source byte-for-byte", () => {
      expect(WRAPPER_CONFIG_SEED.toString()).to.equal("wrapper_config");
    });

    it("WRAPPER_SIGNER_SEED matches Rust source byte-for-byte", () => {
      expect(WRAPPER_SIGNER_SEED.toString()).to.equal("wrapper_signer");
    });
  });

  describe("getWrapperConfigAddress", () => {
    it("derives deterministic config address (same inputs -> same PDA + bump)", () => {
      const [pda1, bump1] = getWrapperConfigAddress(POOL);
      const [pda2, bump2] = getWrapperConfigAddress(POOL);

      expect(pda1.equals(pda2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different pools produce different config PDAs", () => {
      const [pda1] = getWrapperConfigAddress(POOL);
      const [pda2] = getWrapperConfigAddress(OTHER_POOL);

      expect(pda1.equals(pda2)).to.be.false;
    });

    it("ignores the optional derwaMint param (seed is just pool)", () => {
      const [pda1] = getWrapperConfigAddress(POOL, DERWA_MINT);
      const [pda2] = getWrapperConfigAddress(POOL);

      expect(pda1.equals(pda2)).to.be.true;
    });

    it("respects custom programId override", () => {
      const [defaultPda] = getWrapperConfigAddress(POOL);
      const [customPda] = getWrapperConfigAddress(
        POOL,
        undefined,
        OTHER_PROGRAM_ID,
      );

      expect(defaultPda.equals(customPda)).to.be.false;
    });

    it("returns a PublicKey + a valid bump (0..=255)", () => {
      const [pda, bump] = getWrapperConfigAddress(POOL);

      expect(pda).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
      expect(bump).to.be.greaterThanOrEqual(0);
      expect(bump).to.be.lessThanOrEqual(255);
    });

    it("matches PublicKey.findProgramAddressSync directly (seed parity)", () => {
      const [helperPda, helperBump] = getWrapperConfigAddress(POOL);
      const [rawPda, rawBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("wrapper_config"), POOL.toBuffer()],
        DERWA_WRAPPER_PROGRAM_ID,
      );

      expect(helperPda.equals(rawPda)).to.be.true;
      expect(helperBump).to.equal(rawBump);
    });
  });

  describe("getWrapperSignerAddress", () => {
    it("derives deterministic signer address", () => {
      const [pda1, bump1] = getWrapperSignerAddress(POOL);
      const [pda2, bump2] = getWrapperSignerAddress(POOL);

      expect(pda1.equals(pda2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different pools produce different signer PDAs", () => {
      const [pda1] = getWrapperSignerAddress(POOL);
      const [pda2] = getWrapperSignerAddress(OTHER_POOL);

      expect(pda1.equals(pda2)).to.be.false;
    });

    it("signer PDA differs from config PDA for the same pool", () => {
      const [config] = getWrapperConfigAddress(POOL);
      const [signer] = getWrapperSignerAddress(POOL);

      expect(config.equals(signer)).to.be.false;
    });

    it("matches PublicKey.findProgramAddressSync directly (seed parity)", () => {
      const [helperPda, helperBump] = getWrapperSignerAddress(POOL);
      const [rawPda, rawBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("wrapper_signer"), POOL.toBuffer()],
        DERWA_WRAPPER_PROGRAM_ID,
      );

      expect(helperPda.equals(rawPda)).to.be.true;
      expect(helperBump).to.equal(rawBump);
    });
  });

  describe("deriveWrapperAddresses", () => {
    it("returns all four fields with correct types", () => {
      const addrs = deriveWrapperAddresses(POOL);

      expect(addrs.wrapperConfig).to.be.instanceOf(PublicKey);
      expect(addrs.wrapperSigner).to.be.instanceOf(PublicKey);
      expect(addrs.wrapperConfigBump).to.be.a("number");
      expect(addrs.wrapperSignerBump).to.be.a("number");
    });

    it("matches the individual derivation helpers", () => {
      const addrs = deriveWrapperAddresses(POOL);
      const [wc, wcBump] = getWrapperConfigAddress(POOL);
      const [ws, wsBump] = getWrapperSignerAddress(POOL);

      expect(addrs.wrapperConfig.equals(wc)).to.be.true;
      expect(addrs.wrapperConfigBump).to.equal(wcBump);
      expect(addrs.wrapperSigner.equals(ws)).to.be.true;
      expect(addrs.wrapperSignerBump).to.equal(wsBump);
    });

    it("config and signer PDAs are distinct", () => {
      const addrs = deriveWrapperAddresses(POOL);
      expect(addrs.wrapperConfig.equals(addrs.wrapperSigner)).to.be.false;
    });
  });
});
