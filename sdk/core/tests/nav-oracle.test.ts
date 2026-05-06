/** Tests for nav-oracle SDK: state interfaces, params, and the canonical 133-byte signing payload */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  NavAccountState,
  UpdateNavParams,
  InitializeNavAccountParams,
  SigningPayloadFields,
  buildSigningPayload,
  NAV_SIGNING_PAYLOAD_LEN,
  NAV_SIGNING_PAYLOAD_OFFSETS,
  NavOracle,
} from "../src/nav-oracle";
import { NAV_ORACLE_PROGRAM_ID } from "../src/nav-oracle-pda";

describe("SDK Nav Oracle Module", () => {
  const POOL = new PublicKey("So11111111111111111111111111111111111111112");
  const PUBLISHER = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const KEY_ROTATION = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  );

  describe("Constants", () => {
    it("NAV_SIGNING_PAYLOAD_LEN equals the documented 133 bytes", () => {
      expect(NAV_SIGNING_PAYLOAD_LEN).to.equal(133);
    });

    it("NavOracle.PROGRAM_ID matches NAV_ORACLE_PROGRAM_ID", () => {
      expect(NavOracle.PROGRAM_ID.equals(NAV_ORACLE_PROGRAM_ID)).to.be.true;
    });

    it("NAV_SIGNING_PAYLOAD_OFFSETS has the canonical offsets", () => {
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.pool).to.equal(0);
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.navNet).to.equal(32);
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.navGross).to.equal(40);
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.terBps).to.equal(48);
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.lossBps).to.equal(50);
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.navType).to.equal(52);
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.timestamp).to.equal(53);
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.sequence).to.equal(61);
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.publisher).to.equal(69);
      expect(NAV_SIGNING_PAYLOAD_OFFSETS.merkleRoot).to.equal(101);
    });
  });

  describe("NavAccountState interface", () => {
    it("compiles with the expected field shape", () => {
      const state: NavAccountState = {
        pool: POOL,
        navNet: new BN("1000000000"),
        navGross: new BN("1010000000"),
        terBps: 50,
        lossProvisionBps: 25,
        navType: 0,
        padding: [0, 0, 0, 0, 0, 0, 0],
        timestamp: new BN(1_700_000_000),
        sequence: new BN(1),
        publisher: PUBLISHER,
        signature: new Array(64).fill(0),
        loanTapeMerkleRoot: new Array(32).fill(0),
        keyRotationAuthority: KEY_ROTATION,
      };

      expect(state.pool).to.be.instanceOf(PublicKey);
      expect(state.navNet).to.be.instanceOf(BN);
      expect(state.navGross).to.be.instanceOf(BN);
      expect(state.terBps).to.be.a("number");
      expect(state.lossProvisionBps).to.be.a("number");
      expect(state.navType).to.be.a("number");
      expect(state.padding).to.have.length(7);
      expect(state.timestamp).to.be.instanceOf(BN);
      expect(state.sequence).to.be.instanceOf(BN);
      expect(state.publisher).to.be.instanceOf(PublicKey);
      expect(state.signature).to.have.length(64);
      expect(state.loanTapeMerkleRoot).to.have.length(32);
      expect(state.keyRotationAuthority).to.be.instanceOf(PublicKey);
    });
  });

  describe("UpdateNavParams interface", () => {
    it("compiles with the expected fields", () => {
      const params: UpdateNavParams = {
        navNet: new BN("1000000000"),
        navGross: new BN("1010000000"),
        terBps: 50,
        lossBps: 25,
        navType: 0,
        timestamp: new BN(1_700_000_000),
        sequence: new BN(1),
        loanTapeMerkleRoot: new Uint8Array(32),
        signature: new Uint8Array(64),
      };

      expect(params.navNet).to.be.instanceOf(BN);
      expect(params.navGross).to.be.instanceOf(BN);
      expect(params.terBps).to.equal(50);
      expect(params.lossBps).to.equal(25);
      expect(params.navType).to.equal(0);
      expect(params.timestamp).to.be.instanceOf(BN);
      expect(params.sequence).to.be.instanceOf(BN);
      expect(params.loanTapeMerkleRoot).to.have.length(32);
      expect(params.signature).to.have.length(64);
    });
  });

  describe("InitializeNavAccountParams interface", () => {
    it("compiles with pool, publisher, keyRotationAuthority", () => {
      const params: InitializeNavAccountParams = {
        pool: POOL,
        publisher: PUBLISHER,
        keyRotationAuthority: KEY_ROTATION,
      };

      expect(params.pool).to.be.instanceOf(PublicKey);
      expect(params.publisher).to.be.instanceOf(PublicKey);
      expect(params.keyRotationAuthority).to.be.instanceOf(PublicKey);
    });
  });

  describe("buildSigningPayload", () => {
    function makeFields(
      overrides: Partial<SigningPayloadFields> = {},
    ): SigningPayloadFields {
      return {
        pool: POOL,
        navNet: 1_000_000_000n,
        navGross: 1_010_000_000n,
        terBps: 50,
        lossBps: 25,
        navType: 0,
        timestamp: 1_700_000_000n,
        sequence: 7n,
        publisher: PUBLISHER,
        loanTapeMerkleRoot: Buffer.alloc(32, 0xab),
        ...overrides,
      };
    }

    it("returns exactly 133 bytes", () => {
      const buf = buildSigningPayload(makeFields());
      expect(buf.length).to.equal(NAV_SIGNING_PAYLOAD_LEN);
    });

    it("places pool at offset 0..32", () => {
      const buf = buildSigningPayload(makeFields());
      expect(
        buf.subarray(0, 32).equals(POOL.toBuffer()),
      ).to.be.true;
    });

    it("encodes nav_net little-endian at offset 32..40", () => {
      const buf = buildSigningPayload(makeFields({ navNet: 1n }));
      expect(buf.readBigUInt64LE(32)).to.equal(1n);
      // First byte is 1, rest are 0 — confirms little-endian.
      expect(buf[32]).to.equal(1);
      expect(buf[39]).to.equal(0);
    });

    it("encodes nav_gross little-endian at offset 40..48", () => {
      const buf = buildSigningPayload(makeFields({ navGross: 0xdeadbeefn }));
      expect(buf.readBigUInt64LE(40)).to.equal(0xdeadbeefn);
    });

    it("encodes ter_bps little-endian at offset 48..50", () => {
      const buf = buildSigningPayload(makeFields({ terBps: 1234 }));
      expect(buf.readUInt16LE(48)).to.equal(1234);
    });

    it("encodes loss_bps little-endian at offset 50..52", () => {
      const buf = buildSigningPayload(makeFields({ lossBps: 4321 }));
      expect(buf.readUInt16LE(50)).to.equal(4321);
    });

    it("encodes nav_type as a single byte at offset 52", () => {
      const buf0 = buildSigningPayload(makeFields({ navType: 0 }));
      const buf1 = buildSigningPayload(makeFields({ navType: 1 }));
      expect(buf0[52]).to.equal(0);
      expect(buf1[52]).to.equal(1);
    });

    it("encodes timestamp as signed i64 LE at offset 53..61", () => {
      const buf = buildSigningPayload(makeFields({ timestamp: -1n }));
      // -1 as i64 LE = all 0xFF
      for (let i = 53; i < 61; i++) {
        expect(buf[i]).to.equal(0xff);
      }
    });

    it("encodes sequence as u64 LE at offset 61..69", () => {
      const buf = buildSigningPayload(makeFields({ sequence: 0x0102030405060708n }));
      expect(buf.readBigUInt64LE(61)).to.equal(0x0102030405060708n);
    });

    it("places publisher at offset 69..101", () => {
      const buf = buildSigningPayload(makeFields());
      expect(
        buf.subarray(69, 101).equals(PUBLISHER.toBuffer()),
      ).to.be.true;
    });

    it("places loan_tape_merkle_root at offset 101..133", () => {
      const root = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) root[i] = i;
      const buf = buildSigningPayload(
        makeFields({ loanTapeMerkleRoot: root }),
      );
      expect(buf.subarray(101, 133).equals(root)).to.be.true;
    });

    it("accepts BN inputs equivalently to bigint", () => {
      const bigintBuf = buildSigningPayload(
        makeFields({
          navNet: 1_000_000_000n,
          navGross: 1_010_000_000n,
          timestamp: 1_700_000_000n,
          sequence: 7n,
        }),
      );
      const bnBuf = buildSigningPayload(
        makeFields({
          navNet: new BN("1000000000"),
          navGross: new BN("1010000000"),
          timestamp: new BN(1_700_000_000),
          sequence: new BN(7),
        }),
      );
      expect(bigintBuf.equals(bnBuf)).to.be.true;
    });

    it("accepts Uint8Array merkle root", () => {
      const root = new Uint8Array(32);
      for (let i = 0; i < 32; i++) root[i] = (i * 7) & 0xff;
      const buf = buildSigningPayload(
        makeFields({ loanTapeMerkleRoot: root }),
      );
      expect(buf.subarray(101, 133).equals(Buffer.from(root))).to.be.true;
    });

    it("rejects merkle roots of the wrong length", () => {
      expect(() =>
        buildSigningPayload(
          makeFields({ loanTapeMerkleRoot: Buffer.alloc(16) }),
        ),
      ).to.throw(/32 bytes/);
    });

    it("matches the on-chain canonical layout for an all-zeros payload", () => {
      // Mirror Rust signing_payload() with all zeros: 32 + 8 + 8 + 2 + 2 + 1
      // + 8 + 8 + 32 + 32 = 133 bytes, all zero except the pool/publisher
      // pubkeys and the merkle root, which we set explicitly here.
      const zeroPubkey = PublicKey.default;
      const buf = buildSigningPayload({
        pool: zeroPubkey,
        navNet: 0n,
        navGross: 0n,
        terBps: 0,
        lossBps: 0,
        navType: 0,
        timestamp: 0n,
        sequence: 0n,
        publisher: zeroPubkey,
        loanTapeMerkleRoot: Buffer.alloc(32, 0),
      });

      expect(buf.length).to.equal(133);
      // Every byte should be zero in this construction.
      for (let i = 0; i < 133; i++) {
        expect(buf[i]).to.equal(0, `byte ${i} should be zero`);
      }
    });

    it("produces stable output across calls (pure function)", () => {
      const fields = makeFields();
      const a = buildSigningPayload(fields);
      const b = buildSigningPayload(fields);
      expect(a.equals(b)).to.be.true;
    });

    it("matches a hand-assembled byte buffer for known inputs", () => {
      // Independent reference computation — assemble the expected bytes by
      // hand from the documented layout and compare. Catches any drift in
      // either offsets or endianness.
      const fields: SigningPayloadFields = {
        pool: POOL,
        navNet: 1_000_000_000n,
        navGross: 1_010_000_000n,
        terBps: 50,
        lossBps: 25,
        navType: 1,
        timestamp: 1_700_000_000n,
        sequence: 42n,
        publisher: PUBLISHER,
        loanTapeMerkleRoot: Buffer.alloc(32, 0xab),
      };

      const expected = Buffer.alloc(133);
      POOL.toBuffer().copy(expected, 0);
      expected.writeBigUInt64LE(1_000_000_000n, 32);
      expected.writeBigUInt64LE(1_010_000_000n, 40);
      expected.writeUInt16LE(50, 48);
      expected.writeUInt16LE(25, 50);
      expected.writeUInt8(1, 52);
      expected.writeBigInt64LE(1_700_000_000n, 53);
      expected.writeBigUInt64LE(42n, 61);
      PUBLISHER.toBuffer().copy(expected, 69);
      Buffer.alloc(32, 0xab).copy(expected, 101);

      const actual = buildSigningPayload(fields);
      expect(actual.equals(expected)).to.be.true;
    });
  });
});
