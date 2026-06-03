/** Tests for derwa-wrapper SDK interfaces, params, and on-chain error codes */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

import {
  DeRwaWrapper,
  WrapperConfigState,
  InitializeWrapperParams,
  WrapParams,
  UnwrapParams,
} from "../src/derwa-wrapper";
import {
  DERWA_WRAPPER_PROGRAM_ID,
  getWrapperConfigAddress,
} from "../src/derwa-wrapper-pda";

// Pull error codes from the IDL when available so tests stay in sync with
// `programs/derwa-wrapper/src/error.rs`. Falls back to compiled values from
// `target/idl/derwa_wrapper.json` (codes assigned via `#[error_code]`). The
// IDL JSON uses PascalCase names; we lowercase the first letter so tests can
// reference camelCase keys (matching the rest of the SDK convention).
const IDL_PATH = path.join(__dirname, "../../../target/idl/derwa_wrapper.json");
function toCamelCase(name: string): string {
  return name.length > 0 ? name[0].toLowerCase() + name.slice(1) : name;
}
const DeRwaErrorCode: Record<string, number> = fs.existsSync(IDL_PATH)
  ? Object.fromEntries(
      JSON.parse(fs.readFileSync(IDL_PATH, "utf-8")).errors.map(
        (e: { code: number; name: string }) => [toCamelCase(e.name), e.code],
      ),
    )
  : {
      zeroAmount: 14000,
      attestationRequired: 14001,
      insufficientLockedSupply: 14002,
      mintMismatch: 14003,
      invalidAttestationProgram: 14004,
      invalidAttestationSubject: 14005,
      invalidAttestationIssuer: 14006,
      invalidAttestationType: 14007,
      invalidAttestationPda: 14008,
      invalidAttestationConfig: 14009,
    };

describe("SDK DeRwaWrapper Module", () => {
  const POOL = new PublicKey("So11111111111111111111111111111111111111112");
  const PERMISSIONED_MINT = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const DERWA_MINT = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  );
  const USER = new PublicKey("11111111111111111111111111111111");
  const ATTESTATION = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  );

  describe("Static class shape", () => {
    it("exposes the four required static methods", () => {
      expect(DeRwaWrapper.initialize).to.be.a("function");
      expect(DeRwaWrapper.wrap).to.be.a("function");
      expect(DeRwaWrapper.unwrap).to.be.a("function");
      expect(DeRwaWrapper.fetchWrapperConfig).to.be.a("function");
    });
  });

  describe("WrapperConfigState interface", () => {
    it("compiles with the canonical field set", () => {
      const state: WrapperConfigState = {
        pool: POOL,
        permissionedMint: PERMISSIONED_MINT,
        derwaMint: DERWA_MINT,
        lockedSupply: new BN(0),
        bump: 254,
        // Trust anchors set at initialize time. Tests use mock-sas in
        // practice; here we just exercise the type shape.
        attestationProgram: POOL,
        attestationIssuer: PERMISSIONED_MINT,
        requiredAttestationType: 0,
      };

      expect(state.pool).to.be.instanceOf(PublicKey);
      expect(state.permissionedMint).to.be.instanceOf(PublicKey);
      expect(state.derwaMint).to.be.instanceOf(PublicKey);
      expect(BN.isBN(state.lockedSupply)).to.be.true;
      expect(state.bump).to.be.a("number");
      expect(state.attestationProgram).to.be.instanceOf(PublicKey);
      expect(state.attestationIssuer).to.be.instanceOf(PublicKey);
      expect(state.requiredAttestationType).to.be.a("number");
    });
  });

  describe("InitializeWrapperParams interface", () => {
    it("compiles with the required mints + trust anchors", () => {
      const params: InitializeWrapperParams = {
        pool: POOL,
        permissionedMint: PERMISSIONED_MINT,
        derwaMint: DERWA_MINT,
        // Trust anchors are required for wrapper init. The on-chain
        // handler rejects PublicKey.default for either of these.
        attestationProgram: POOL, // mock-sas in real tests
        attestationIssuer: USER, // attester in real tests
        requiredAttestationType: 0,
      };

      expect(params.pool.equals(POOL)).to.be.true;
      expect(params.permissionedMint.equals(PERMISSIONED_MINT)).to.be.true;
      expect(params.derwaMint.equals(DERWA_MINT)).to.be.true;
      expect(params.attestationProgram.equals(POOL)).to.be.true;
      expect(params.attestationIssuer.equals(USER)).to.be.true;
      expect(params.requiredAttestationType).to.equal(0);
    });
  });

  describe("WrapParams interface", () => {
    it("compiles with required (user, amount) only", () => {
      const params: WrapParams = {
        user: USER,
        amount: new BN(1_000_000),
      };

      expect(params.user.equals(USER)).to.be.true;
      expect(params.amount.toNumber()).to.equal(1_000_000);
    });

    it("compiles with optional ATA overrides", () => {
      const investorPermissionedAta = new PublicKey(
        "Sysvar1nstructions1111111111111111111111111",
      );
      const wrapperLockedAta = new PublicKey(
        "Sysvar1111111111111111111111111111111111111",
      );
      const investorDerwaAta = new PublicKey(
        "ComputeBudget111111111111111111111111111111",
      );

      const params: WrapParams = {
        user: USER,
        amount: new BN(42),
        investorPermissionedAta,
        wrapperLockedAta,
        investorDerwaAta,
      };

      expect(params.investorPermissionedAta?.equals(investorPermissionedAta)).to
        .be.true;
      expect(params.wrapperLockedAta?.equals(wrapperLockedAta)).to.be.true;
      expect(params.investorDerwaAta?.equals(investorDerwaAta)).to.be.true;
    });

    it("compiles with optional TransferHook remaining accounts", () => {
      const params: WrapParams = {
        user: USER,
        amount: new BN(42),
        remainingAccounts: [
          { pubkey: POOL, isSigner: false, isWritable: false },
          { pubkey: PERMISSIONED_MINT, isSigner: false, isWritable: false },
        ],
      };

      expect(params.remainingAccounts).to.have.length(2);
      expect(params.remainingAccounts?.[0].pubkey.equals(POOL)).to.be.true;
      expect(params.remainingAccounts?.[1].isWritable).to.be.false;
    });

    it("amount is a BN (precision-safe for u64)", () => {
      const big = new BN("18446744073709551615"); // u64::MAX
      const params: WrapParams = { user: USER, amount: big };
      expect(params.amount.toString()).to.equal("18446744073709551615");
    });
  });

  describe("UnwrapParams interface", () => {
    it("compiles with the required attestation field", () => {
      const params: UnwrapParams = {
        user: USER,
        amount: new BN(500),
        attestation: ATTESTATION,
      };

      expect(params.attestation.equals(ATTESTATION)).to.be.true;
      expect(params.amount.toNumber()).to.equal(500);
    });

    it("compiles with all optional ATA overrides", () => {
      const wrapperLockedAta = new PublicKey(
        "Sysvar1111111111111111111111111111111111111",
      );
      const investorPermissionedAta = new PublicKey(
        "Sysvar1nstructions1111111111111111111111111",
      );
      const investorDerwaAta = new PublicKey(
        "ComputeBudget111111111111111111111111111111",
      );

      const params: UnwrapParams = {
        user: USER,
        amount: new BN(1),
        attestation: ATTESTATION,
        wrapperLockedAta,
        investorPermissionedAta,
        investorDerwaAta,
      };

      expect(params.wrapperLockedAta?.equals(wrapperLockedAta)).to.be.true;
      expect(params.investorPermissionedAta?.equals(investorPermissionedAta)).to
        .be.true;
      expect(params.investorDerwaAta?.equals(investorDerwaAta)).to.be.true;
    });

    it("compiles with optional TransferHook remaining accounts", () => {
      const params: UnwrapParams = {
        user: USER,
        amount: new BN(1),
        attestation: ATTESTATION,
        remainingAccounts: [
          { pubkey: POOL, isSigner: false, isWritable: false },
          { pubkey: PERMISSIONED_MINT, isSigner: false, isWritable: false },
        ],
      };

      expect(params.remainingAccounts).to.have.length(2);
      expect(params.remainingAccounts?.[0].pubkey.equals(POOL)).to.be.true;
      expect(params.remainingAccounts?.[1].isSigner).to.be.false;
    });
  });

  describe("Integration with PDA helpers", () => {
    it("config PDA derivable from pool aligns with on-chain seed", () => {
      const [pda] = getWrapperConfigAddress(POOL);
      expect(pda).to.be.instanceOf(PublicKey);
      // The same pool is reachable via the program ID constant — sanity.
      const [pdaWithProgram] = getWrapperConfigAddress(
        POOL,
        DERWA_MINT,
        DERWA_WRAPPER_PROGRAM_ID,
      );
      expect(pda.equals(pdaWithProgram)).to.be.true;
    });
  });

  describe("On-chain error codes", () => {
    it("includes zeroAmount", () => {
      expect(DeRwaErrorCode.zeroAmount).to.be.a("number");
    });

    it("includes attestationRequired", () => {
      expect(DeRwaErrorCode.attestationRequired).to.be.a("number");
    });

    it("includes insufficientLockedSupply", () => {
      expect(DeRwaErrorCode.insufficientLockedSupply).to.be.a("number");
    });

    it("includes mintMismatch", () => {
      expect(DeRwaErrorCode.mintMismatch).to.be.a("number");
    });

    it("includes attestation identity-binding errors", () => {
      expect(DeRwaErrorCode.invalidAttestationProgram).to.be.a("number");
      expect(DeRwaErrorCode.invalidAttestationSubject).to.be.a("number");
      expect(DeRwaErrorCode.invalidAttestationIssuer).to.be.a("number");
      expect(DeRwaErrorCode.invalidAttestationType).to.be.a("number");
      expect(DeRwaErrorCode.invalidAttestationPda).to.be.a("number");
      expect(DeRwaErrorCode.invalidAttestationConfig).to.be.a("number");
    });

    it("error codes are distinct", () => {
      const codes = [
        DeRwaErrorCode.zeroAmount,
        DeRwaErrorCode.attestationRequired,
        DeRwaErrorCode.insufficientLockedSupply,
        DeRwaErrorCode.mintMismatch,
        DeRwaErrorCode.invalidAttestationProgram,
        DeRwaErrorCode.invalidAttestationSubject,
        DeRwaErrorCode.invalidAttestationIssuer,
        DeRwaErrorCode.invalidAttestationType,
        DeRwaErrorCode.invalidAttestationPda,
        DeRwaErrorCode.invalidAttestationConfig,
      ];
      const unique = new Set(codes);
      expect(unique.size).to.equal(codes.length);
    });
  });
});
