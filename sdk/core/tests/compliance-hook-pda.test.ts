/** Tests for compliance-hook PDA derivation: mint_config, sanctions_list, EAML */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  COMPLIANCE_HOOK_PROGRAM_ID,
  EXTRA_ACCOUNT_METAS_SEED,
  COMPLIANCE_FROZEN_ACCOUNT_SEED,
  MINT_CONFIG_SEED,
  SANCTIONS_LIST_SEED,
  deriveComplianceHookAddresses,
  getComplianceFrozenAccountAddress,
  getExtraAccountMetaListAddress,
  getMintConfigAddress,
  getSanctionsListAddress,
} from "../src/compliance-hook-pda";

describe("SDK ComplianceHook PDA Module", () => {
  const MINT_A = new PublicKey("So11111111111111111111111111111111111111112");
  const MINT_B = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const ALT_PROGRAM_ID = new PublicKey(
    "SVS1111111111111111111111111111111111111111",
  );

  describe("Constants", () => {
    it("MINT_CONFIG_SEED encodes 'mint_config'", () => {
      expect(MINT_CONFIG_SEED.toString()).to.equal("mint_config");
    });

    it("SANCTIONS_LIST_SEED encodes 'sanctions_list'", () => {
      expect(SANCTIONS_LIST_SEED.toString()).to.equal("sanctions_list");
    });

    it("EXTRA_ACCOUNT_METAS_SEED encodes 'extra-account-metas' (hyphens, not underscores)", () => {
      expect(EXTRA_ACCOUNT_METAS_SEED.toString()).to.equal(
        "extra-account-metas",
      );
      // Belt-and-suspenders: the hyphen seed is fixed by Token-2022 spec;
      // catch accidental rename to underscore form.
      expect(EXTRA_ACCOUNT_METAS_SEED.toString()).to.not.contain("_");
    });

    it("COMPLIANCE_FROZEN_ACCOUNT_SEED encodes 'frozen'", () => {
      expect(COMPLIANCE_FROZEN_ACCOUNT_SEED.toString()).to.equal("frozen");
    });

    it("COMPLIANCE_HOOK_PROGRAM_ID matches deployed program ID", () => {
      expect(COMPLIANCE_HOOK_PROGRAM_ID.toBase58()).to.equal(
        "6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P",
      );
      expect(COMPLIANCE_HOOK_PROGRAM_ID).to.be.instanceOf(PublicKey);
    });
  });

  describe("getComplianceFrozenAccountAddress", () => {
    it("derives deterministic frozen account address", () => {
      const [a1, b1] = getComplianceFrozenAccountAddress(MINT_A);
      const [a2, b2] = getComplianceFrozenAccountAddress(MINT_A);
      expect(a1.equals(a2)).to.be.true;
      expect(b1).to.equal(b2);
    });

    it("different owners produce different frozen account addresses", () => {
      const [pdaA] = getComplianceFrozenAccountAddress(MINT_A);
      const [pdaB] = getComplianceFrozenAccountAddress(MINT_B);
      expect(pdaA.equals(pdaB)).to.be.false;
    });

    it("different programIds produce different frozen account addresses", () => {
      const [defaultPda] = getComplianceFrozenAccountAddress(MINT_A);
      const [altPda] = getComplianceFrozenAccountAddress(MINT_A, ALT_PROGRAM_ID);
      expect(defaultPda.equals(altPda)).to.be.false;
    });
  });

  describe("getMintConfigAddress", () => {
    it("derives deterministic mint config address", () => {
      const [a1, b1] = getMintConfigAddress(MINT_A);
      const [a2, b2] = getMintConfigAddress(MINT_A);
      expect(a1.equals(a2)).to.be.true;
      expect(b1).to.equal(b2);
    });

    it("returns a non-on-curve PDA + valid bump", () => {
      const [pda, bump] = getMintConfigAddress(MINT_A);
      expect(pda).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
      expect(bump).to.be.lessThanOrEqual(255);
      expect(bump).to.be.greaterThanOrEqual(0);
      expect(PublicKey.isOnCurve(pda.toBytes())).to.be.false;
    });

    it("different mints produce different addresses", () => {
      const [pdaA] = getMintConfigAddress(MINT_A);
      const [pdaB] = getMintConfigAddress(MINT_B);
      expect(pdaA.equals(pdaB)).to.be.false;
    });

    it("different programIds produce different addresses for the same mint", () => {
      const [defaultPda] = getMintConfigAddress(MINT_A);
      const [altPda] = getMintConfigAddress(MINT_A, ALT_PROGRAM_ID);
      expect(defaultPda.equals(altPda)).to.be.false;
    });

    it("uses COMPLIANCE_HOOK_PROGRAM_ID by default", () => {
      const [defaultPda] = getMintConfigAddress(MINT_A);
      const [explicitPda] = getMintConfigAddress(
        MINT_A,
        COMPLIANCE_HOOK_PROGRAM_ID,
      );
      expect(defaultPda.equals(explicitPda)).to.be.true;
    });
  });

  describe("getSanctionsListAddress", () => {
    it("derives deterministic singleton address", () => {
      const [a1, b1] = getSanctionsListAddress();
      const [a2, b2] = getSanctionsListAddress();
      expect(a1.equals(a2)).to.be.true;
      expect(b1).to.equal(b2);
    });

    it("returns a non-on-curve PDA + valid bump", () => {
      const [pda, bump] = getSanctionsListAddress();
      expect(pda).to.be.instanceOf(PublicKey);
      expect(bump).to.be.lessThanOrEqual(255);
      expect(bump).to.be.greaterThanOrEqual(0);
      expect(PublicKey.isOnCurve(pda.toBytes())).to.be.false;
    });

    it("different programIds produce different addresses", () => {
      const [defaultPda] = getSanctionsListAddress();
      const [altPda] = getSanctionsListAddress(ALT_PROGRAM_ID);
      expect(defaultPda.equals(altPda)).to.be.false;
    });
  });

  describe("getExtraAccountMetaListAddress", () => {
    it("derives deterministic EAML address", () => {
      const [a1, b1] = getExtraAccountMetaListAddress(MINT_A);
      const [a2, b2] = getExtraAccountMetaListAddress(MINT_A);
      expect(a1.equals(a2)).to.be.true;
      expect(b1).to.equal(b2);
    });

    it("returns a non-on-curve PDA + valid bump", () => {
      const [pda, bump] = getExtraAccountMetaListAddress(MINT_A);
      expect(pda).to.be.instanceOf(PublicKey);
      expect(bump).to.be.lessThanOrEqual(255);
      expect(bump).to.be.greaterThanOrEqual(0);
      expect(PublicKey.isOnCurve(pda.toBytes())).to.be.false;
    });

    it("different mints produce different EAML addresses", () => {
      const [pdaA] = getExtraAccountMetaListAddress(MINT_A);
      const [pdaB] = getExtraAccountMetaListAddress(MINT_B);
      expect(pdaA.equals(pdaB)).to.be.false;
    });

    it("EAML address is distinct from MintConfig address for the same mint", () => {
      const [eaml] = getExtraAccountMetaListAddress(MINT_A);
      const [mintConfig] = getMintConfigAddress(MINT_A);
      expect(eaml.equals(mintConfig)).to.be.false;
    });

    it("different programIds produce different EAML addresses", () => {
      const [defaultPda] = getExtraAccountMetaListAddress(MINT_A);
      const [altPda] = getExtraAccountMetaListAddress(MINT_A, ALT_PROGRAM_ID);
      expect(defaultPda.equals(altPda)).to.be.false;
    });
  });

  describe("deriveComplianceHookAddresses", () => {
    it("returns all six fields with correct types", () => {
      const a = deriveComplianceHookAddresses(MINT_A);
      expect(a.mintConfig).to.be.instanceOf(PublicKey);
      expect(a.extraAccountMetaList).to.be.instanceOf(PublicKey);
      expect(a.sanctionsList).to.be.instanceOf(PublicKey);
      expect(a.mintConfigBump).to.be.a("number");
      expect(a.extraAccountMetaListBump).to.be.a("number");
      expect(a.sanctionsListBump).to.be.a("number");
    });

    it("matches results from individual derivers", () => {
      const a = deriveComplianceHookAddresses(MINT_A);
      const [mintConfig, mintConfigBump] = getMintConfigAddress(MINT_A);
      const [eaml, eamlBump] = getExtraAccountMetaListAddress(MINT_A);
      const [sl, slBump] = getSanctionsListAddress();

      expect(a.mintConfig.equals(mintConfig)).to.be.true;
      expect(a.mintConfigBump).to.equal(mintConfigBump);
      expect(a.extraAccountMetaList.equals(eaml)).to.be.true;
      expect(a.extraAccountMetaListBump).to.equal(eamlBump);
      expect(a.sanctionsList.equals(sl)).to.be.true;
      expect(a.sanctionsListBump).to.equal(slBump);
    });

    it("all bumps are valid (0-255)", () => {
      const a = deriveComplianceHookAddresses(MINT_A);
      for (const bump of [
        a.mintConfigBump,
        a.extraAccountMetaListBump,
        a.sanctionsListBump,
      ]) {
        expect(bump).to.be.lessThanOrEqual(255);
        expect(bump).to.be.greaterThanOrEqual(0);
      }
    });

    it("sanctions list address is identical across different mints (singleton)", () => {
      const a = deriveComplianceHookAddresses(MINT_A);
      const b = deriveComplianceHookAddresses(MINT_B);
      expect(a.sanctionsList.equals(b.sanctionsList)).to.be.true;
    });

    it("mintConfig and EAML differ across mints", () => {
      const a = deriveComplianceHookAddresses(MINT_A);
      const b = deriveComplianceHookAddresses(MINT_B);
      expect(a.mintConfig.equals(b.mintConfig)).to.be.false;
      expect(a.extraAccountMetaList.equals(b.extraAccountMetaList)).to.be.false;
    });
  });
});
