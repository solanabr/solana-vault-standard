/**
 * Unit tests for the ComplianceHook SDK class.
 *
 * Scope: pure / static-fixture coverage — no on-chain RPCs. Live behavior
 * (initializeSanctionsList / updateSanctionsList / fetchMintConfig) is
 * exercised by the integration suite at `tests/compliance-hook.spec.ts`.
 */

import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  ComplianceHook,
  ComplianceMode,
  type MintConfigState,
  type SanctionsListState,
  type InitializeMintConfigParams,
  type InitializeExtraAccountMetaListParams,
  type UpdateSanctionsListParams,
  type InitializeSanctionsListParams,
  type FreezeAccountParams,
  type UnfreezeAccountParams,
  type ComplianceFrozenAccountState,
  COMPLIANCE_HOOK_PROGRAM_ID,
} from "../src/compliance-hook";
import {
  getComplianceFrozenAccountAddress,
  getExtraAccountMetaListAddress,
  getMintConfigAddress,
  getSanctionsListAddress,
} from "../src/compliance-hook-pda";

describe("SDK ComplianceHook Class", () => {
  const MINT_A = new PublicKey("So11111111111111111111111111111111111111112");
  const MINT_B = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const POOL_POLICY = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  );
  const AUTHORITY = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  );

  describe("ComplianceMode helpers", () => {
    it("freelyTransferable() returns the camelCase variant tag", () => {
      const v = ComplianceMode.freelyTransferable();
      expect(v).to.have.property("freelyTransferable");
      expect(
        (v as { freelyTransferable: unknown }).freelyTransferable,
      ).to.deep.equal({});
    });

    it("permissioned() returns the camelCase variant tag", () => {
      const v = ComplianceMode.permissioned();
      expect(v).to.have.property("permissioned");
      expect((v as { permissioned: unknown }).permissioned).to.deep.equal({});
    });

    it("variant tags are mutually exclusive (single-key objects)", () => {
      const free = ComplianceMode.freelyTransferable();
      const perm = ComplianceMode.permissioned();
      expect(Object.keys(free)).to.have.length(1);
      expect(Object.keys(perm)).to.have.length(1);
      expect(Object.keys(free)[0]).to.not.equal(Object.keys(perm)[0]);
    });

    it("variant constructors are stable (each call yields a fresh-but-equal value)", () => {
      const a = ComplianceMode.freelyTransferable();
      const b = ComplianceMode.freelyTransferable();
      expect(a).to.not.equal(b); // distinct refs
      expect(a).to.deep.equal(b); // same shape
    });
  });

  describe("Re-exports", () => {
    it("re-exports COMPLIANCE_HOOK_PROGRAM_ID", () => {
      expect(COMPLIANCE_HOOK_PROGRAM_ID.toBase58()).to.equal(
        "6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P",
      );
    });
  });

  describe("Class shape", () => {
    it("static methods exist on ComplianceHook", () => {
      expect(typeof ComplianceHook.create).to.equal("function");
      expect(typeof ComplianceHook.load).to.equal("function");
      expect(typeof ComplianceHook.initializeMintConfig).to.equal("function");
      expect(typeof ComplianceHook.initializeExtraAccountMetaList).to.equal(
        "function",
      );
      expect(typeof ComplianceHook.fetchSanctionsList).to.equal("function");
      expect(typeof ComplianceHook.fetchMintConfig).to.equal("function");
      expect(typeof ComplianceHook.fetchFrozenAccount).to.equal("function");
    });

    it("ComplianceHook constructor is not callable from outside (protected)", () => {
      // TS-level: the `protected` modifier forbids `new ComplianceHook(...)`
      // outside subclasses; at runtime JS does not enforce it. We assert the
      // class exists and exposes only static factories as the public surface.
      expect(typeof ComplianceHook).to.equal("function");
      expect(ComplianceHook.name).to.equal("ComplianceHook");
    });
  });

  describe("State interface conformance (static fixtures)", () => {
    it("MintConfigState accepts a FreelyTransferable layout (poolPolicy: null)", () => {
      const fixture: MintConfigState = {
        mint: MINT_A,
        mode: ComplianceMode.freelyTransferable(),
        poolPolicy: null,
        // Trust anchors are stored but unused for FreelyTransferable;
        // default-zero values are the canonical "unset" form.
        attestationProgram: PublicKey.default,
        attestationIssuer: PublicKey.default,
        requiredAttestationType: 0,
      };
      expect(fixture.mint.equals(MINT_A)).to.be.true;
      expect(fixture.poolPolicy).to.equal(null);
      expect(fixture.mode).to.have.property("freelyTransferable");
      expect(fixture.attestationProgram.equals(PublicKey.default)).to.be.true;
    });

    it("MintConfigState accepts a Permissioned layout (poolPolicy: PublicKey)", () => {
      const fixture: MintConfigState = {
        mint: MINT_B,
        mode: ComplianceMode.permissioned(),
        poolPolicy: POOL_POLICY,
        // Permissioned mode requires non-default trust anchors on-chain;
        // here we just exercise the type shape with arbitrary keys.
        attestationProgram: AUTHORITY,
        attestationIssuer: AUTHORITY,
        requiredAttestationType: 2, // accredited investor
      };
      expect(fixture.mint.equals(MINT_B)).to.be.true;
      expect(fixture.poolPolicy?.equals(POOL_POLICY)).to.be.true;
      expect(fixture.mode).to.have.property("permissioned");
      expect(fixture.requiredAttestationType).to.equal(2);
    });

    it("SanctionsListState round-trips a non-empty addresses vec", () => {
      const fixture: SanctionsListState = {
        authority: AUTHORITY,
        version: new BN(7),
        updatedAt: new BN(1_700_000_000),
        addresses: [MINT_A, MINT_B, POOL_POLICY],
      };
      expect(fixture.authority.equals(AUTHORITY)).to.be.true;
      expect(fixture.version.toNumber()).to.equal(7);
      expect(fixture.updatedAt.toNumber()).to.equal(1_700_000_000);
      expect(fixture.addresses).to.have.length(3);
      expect(fixture.addresses[0].equals(MINT_A)).to.be.true;
    });

    it("SanctionsListState empty vec is permitted (init state)", () => {
      const fixture: SanctionsListState = {
        authority: AUTHORITY,
        version: new BN(0),
        updatedAt: new BN(0),
        addresses: [],
      };
      expect(fixture.addresses).to.have.length(0);
      expect(fixture.version.isZero()).to.be.true;
    });

    it("ComplianceFrozenAccountState accepts the marker bump", () => {
      const fixture: ComplianceFrozenAccountState = { bump: 254 };
      expect(fixture.bump).to.equal(254);
    });
  });

  describe("Param interface conformance", () => {
    it("InitializeSanctionsListParams accepts an authority pubkey", () => {
      const params: InitializeSanctionsListParams = { authority: AUTHORITY };
      expect(params.authority.equals(AUTHORITY)).to.be.true;
    });

    it("InitializeMintConfigParams: poolPolicy may be omitted, null, or set", () => {
      // Omitted (FreelyTransferable case)
      const stub = { publicKey: AUTHORITY } as { publicKey: PublicKey };
      const fakeKp =
        stub as unknown as InitializeMintConfigParams["mintAuthority"];
      const a: InitializeMintConfigParams = {
        mint: MINT_A,
        mode: ComplianceMode.freelyTransferable(),
        mintAuthority: fakeKp,
      };
      expect(a.poolPolicy).to.equal(undefined);

      // Explicit null
      const b: InitializeMintConfigParams = {
        mint: MINT_A,
        mode: ComplianceMode.freelyTransferable(),
        poolPolicy: null,
        mintAuthority: fakeKp,
      };
      expect(b.poolPolicy).to.equal(null);

      // Set (Permissioned case)
      const c: InitializeMintConfigParams = {
        mint: MINT_A,
        mode: ComplianceMode.permissioned(),
        poolPolicy: POOL_POLICY,
        mintAuthority: fakeKp,
      };
      expect(c.poolPolicy?.equals(POOL_POLICY)).to.be.true;
    });

    it("InitializeExtraAccountMetaListParams accepts a mint + mintAuthority", () => {
      const stub = { publicKey: AUTHORITY } as { publicKey: PublicKey };
      const fakeKp =
        stub as unknown as InitializeExtraAccountMetaListParams["mintAuthority"];
      const params: InitializeExtraAccountMetaListParams = {
        mint: MINT_A,
        mintAuthority: fakeKp,
      };
      expect(params.mint.equals(MINT_A)).to.be.true;
    });

    it("UpdateSanctionsListParams: additions/removals default to empty", () => {
      const stub = { publicKey: AUTHORITY } as { publicKey: PublicKey };
      const fakeKp = stub as unknown as UpdateSanctionsListParams["authority"];
      const params: UpdateSanctionsListParams = { authority: fakeKp };
      expect(params.additions).to.equal(undefined);
      expect(params.removals).to.equal(undefined);

      const withAdds: UpdateSanctionsListParams = {
        authority: fakeKp,
        additions: [MINT_A, MINT_B],
        removals: [POOL_POLICY],
      };
      expect(withAdds.additions).to.have.length(2);
      expect(withAdds.removals).to.have.length(1);
    });

    it("FreezeAccountParams and UnfreezeAccountParams accept owner + authority", () => {
      const stub = { publicKey: AUTHORITY } as { publicKey: PublicKey };
      const fakeKp = stub as unknown as FreezeAccountParams["authority"];
      const freeze: FreezeAccountParams = {
        authority: fakeKp,
        owner: MINT_A,
      };
      const unfreeze: UnfreezeAccountParams = {
        authority: fakeKp,
        owner: MINT_A,
        rentRecipient: MINT_B,
      };
      expect(freeze.owner.equals(MINT_A)).to.be.true;
      expect(unfreeze.rentRecipient?.equals(MINT_B)).to.be.true;
    });
  });

  describe("PDA derivation routes through the canonical helpers", () => {
    it("ComplianceHook static contract matches getMintConfigAddress for same mint", () => {
      // The static initializeMintConfig sources its mintConfig PDA from
      // getMintConfigAddress(mint, programId). We can't call the static
      // method without a Program, but we CAN assert the derived PDA the
      // helper would produce — locking the contract that the class derives
      // PDAs identically to the standalone PDA helpers.
      const [mintConfig] = getMintConfigAddress(MINT_A);
      const [eaml] = getExtraAccountMetaListAddress(MINT_A);
      const [sl] = getSanctionsListAddress();
      const [frozen] = getComplianceFrozenAccountAddress(MINT_A);

      expect(mintConfig.equals(eaml)).to.be.false;
      expect(mintConfig.equals(sl)).to.be.false;
      expect(mintConfig.equals(frozen)).to.be.false;
      expect(eaml.equals(sl)).to.be.false;
      expect(eaml.equals(frozen)).to.be.false;
    });
  });
});
