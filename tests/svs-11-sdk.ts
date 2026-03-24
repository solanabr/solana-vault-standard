import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs11 } from "../target/types/svs_11";
import { MockOracle } from "../target/types/mock_oracle";
import { CreditVault } from "../sdk/core/src/credit-vault";

const PRICE_SCALE = new BN(1_000_000_000);

describe("svs-11-sdk (CreditVault SDK)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs11 as Program<Svs11>;
  const oracleProgram = anchor.workspace.MockOracle as Program<MockOracle>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const vaultId = new BN(99);
  const minimumInvestment = new BN(1_000_000);
  const maxStaleness = new BN(3600);

  let assetMint: PublicKey;
  let navOracle: PublicKey;
  let cv: CreditVault;

  before(async () => {
    assetMint = await createMint(
      connection, payer, payer.publicKey, null, 6,
      Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
    );

    [navOracle] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle")],
      oracleProgram.programId,
    );

    await oracleProgram.methods
      .setPrice(PRICE_SCALE)
      .accountsPartial({
        authority: payer.publicKey,
        oracleData: navOracle,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  describe("CreditVault.create()", () => {
    it("creates a vault via SDK and returns a CreditVault instance", async () => {
      cv = await CreditVault.create(program as unknown as Program, {
        assetMint,
        manager: payer.publicKey,
        vaultId,
        navOracle,
        oracleProgram: oracleProgram.programId,
        attester: Keypair.generate().publicKey,
        attestationProgram: new PublicKey("4azCqYgLHDRmsiR6kmYu6v5qvzamaYGqZcmx8MrnrKMc"),
        minimumInvestment,
        maxStaleness,
      });

      expect(cv).to.be.instanceOf(CreditVault);
      expect(cv.assetMint.toBase58()).to.equal(assetMint.toBase58());
      expect(cv.vaultId.toNumber()).to.equal(vaultId.toNumber());
    });
  });

  describe("CreditVault.load()", () => {
    it("loads an existing vault from chain", async () => {
      const loaded = await CreditVault.load(
        program as unknown as Program,
        assetMint,
        vaultId,
      );

      expect(loaded.vault.toBase58()).to.equal(cv.vault.toBase58());
      expect(loaded.sharesMint.toBase58()).to.equal(cv.sharesMint.toBase58());
    });
  });

  describe("getState()", () => {
    it("returns vault state with expected fields", async () => {
      const state = await cv.getState();

      expect(state.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(state.manager.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(state.assetMint.toBase58()).to.equal(assetMint.toBase58());
      expect(state.minimumInvestment.toNumber()).to.equal(minimumInvestment.toNumber());
      expect(state.paused).to.equal(false);
      expect(state.investmentWindowOpen).to.equal(false);
    });
  });

  describe("totalAssets() / totalShares()", () => {
    it("returns zero for a fresh vault", async () => {
      const assets = await cv.totalAssets();
      const shares = await cv.totalShares();

      expect(assets.toNumber()).to.equal(0);
      expect(shares.toNumber()).to.equal(0);
    });
  });

  describe("convertToShares() / convertToAssets()", () => {
    it("returns correct values with virtual offset at empty vault", async () => {
      const state = await cv.refresh();
      const offset = state.decimalsOffset;

      const sharesOut = cv.convertToShares(BigInt(1_000_000), BigInt(0), BigInt(0), offset);
      expect(sharesOut > BigInt(0)).to.be.true;

      const assetsOut = cv.convertToAssets(sharesOut, BigInt(0), BigInt(0), offset);
      expect(assetsOut > BigInt(0)).to.be.true;
    });

    it("round-trips at 1:1 with rounding in favor of vault", async () => {
      const state = await cv.refresh();
      const offset = state.decimalsOffset;
      const ta = BigInt(1_000_000_000);
      const ts = BigInt(1_000_000_000);

      const shares = cv.convertToShares(BigInt(1_000_000), ta, ts, offset);
      const assets = cv.convertToAssets(shares, ta, ts, offset);

      expect(assets).to.equal(BigInt(999_999));
    });
  });

  // Deposit/redeem lifecycle tested in svs-11.ts with proper signers.
  // SDK methods call .rpc() without additional signers, so multi-party
  // flows (investor + manager) require the integration test harness.
});
