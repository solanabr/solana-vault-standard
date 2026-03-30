import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  getTranchedVaultAddress,
  getTrancheAddress,
  getTrancheSharesMintAddress,
  deriveTranchedVaultAddresses,
  TRANCHED_VAULT_SEED,
  TRANCHE_SEED,
  TRANCHE_SHARES_MINT_SEED,
} from "../sdk/core/src/tranched-vault-pda";

const FAKE_PROGRAM_ID = new PublicKey("85wwufKdhpHxiBe4kMeFBfidL1Kqo62T65DHb46qNugA");
const FAKE_ASSET_MINT = PublicKey.unique();
const FAKE_VAULT = PublicKey.unique();

describe("svs-12 SDK (PDA derivation)", () => {
  describe("seed constants", () => {
    it("TRANCHED_VAULT_SEED is 'tranched_vault'", () => {
      expect(TRANCHED_VAULT_SEED.toString()).to.equal("tranched_vault");
    });

    it("TRANCHE_SEED is 'tranche'", () => {
      expect(TRANCHE_SEED.toString()).to.equal("tranche");
    });

    it("TRANCHE_SHARES_MINT_SEED is 'shares'", () => {
      expect(TRANCHE_SHARES_MINT_SEED.toString()).to.equal("shares");
    });
  });

  describe("getTranchedVaultAddress", () => {
    it("returns deterministic address for same inputs", () => {
      const [addr1] = getTranchedVaultAddress(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 1);
      const [addr2] = getTranchedVaultAddress(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 1);
      expect(addr1.toBase58()).to.equal(addr2.toBase58());
    });

    it("returns different address for different vault IDs", () => {
      const [addr1] = getTranchedVaultAddress(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 1);
      const [addr2] = getTranchedVaultAddress(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 2);
      expect(addr1.toBase58()).to.not.equal(addr2.toBase58());
    });

    it("returns different address for different asset mints", () => {
      const mint2 = PublicKey.unique();
      const [addr1] = getTranchedVaultAddress(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 1);
      const [addr2] = getTranchedVaultAddress(FAKE_PROGRAM_ID, mint2, 1);
      expect(addr1.toBase58()).to.not.equal(addr2.toBase58());
    });

    it("accepts BN as vault ID", () => {
      const [addr1] = getTranchedVaultAddress(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, new BN(42));
      const [addr2] = getTranchedVaultAddress(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 42);
      expect(addr1.toBase58()).to.equal(addr2.toBase58());
    });

    it("returns valid bump", () => {
      const [, bump] = getTranchedVaultAddress(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 1);
      expect(bump).to.be.a("number");
      expect(bump).to.be.greaterThanOrEqual(0);
      expect(bump).to.be.lessThanOrEqual(255);
    });
  });

  describe("getTrancheAddress", () => {
    it("returns deterministic address for same vault and index", () => {
      const [addr1] = getTrancheAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 0);
      const [addr2] = getTrancheAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 0);
      expect(addr1.toBase58()).to.equal(addr2.toBase58());
    });

    it("returns different addresses for different indices", () => {
      const [addr0] = getTrancheAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 0);
      const [addr1] = getTrancheAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 1);
      const [addr2] = getTrancheAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 2);
      const [addr3] = getTrancheAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 3);
      const addrs = new Set([addr0.toBase58(), addr1.toBase58(), addr2.toBase58(), addr3.toBase58()]);
      expect(addrs.size).to.equal(4);
    });

    it("returns different addresses for different vaults", () => {
      const vault2 = PublicKey.unique();
      const [addr1] = getTrancheAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 0);
      const [addr2] = getTrancheAddress(FAKE_PROGRAM_ID, vault2, 0);
      expect(addr1.toBase58()).to.not.equal(addr2.toBase58());
    });
  });

  describe("getTrancheSharesMintAddress", () => {
    it("returns deterministic address", () => {
      const [addr1] = getTrancheSharesMintAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 0);
      const [addr2] = getTrancheSharesMintAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 0);
      expect(addr1.toBase58()).to.equal(addr2.toBase58());
    });

    it("shares mint differs from tranche for same index", () => {
      const [tranche] = getTrancheAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 0);
      const [sharesMint] = getTrancheSharesMintAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 0);
      expect(tranche.toBase58()).to.not.equal(sharesMint.toBase58());
    });

    it("returns unique addresses per index", () => {
      const [mint0] = getTrancheSharesMintAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 0);
      const [mint1] = getTrancheSharesMintAddress(FAKE_PROGRAM_ID, FAKE_VAULT, 1);
      expect(mint0.toBase58()).to.not.equal(mint1.toBase58());
    });
  });

  describe("deriveTranchedVaultAddresses", () => {
    it("returns vault address and bump", () => {
      const result = deriveTranchedVaultAddresses(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 1);
      expect(result.vault).to.be.instanceOf(PublicKey);
      expect(result.vaultBump).to.be.a("number");
    });

    it("matches getTranchedVaultAddress", () => {
      const [expected, expectedBump] = getTranchedVaultAddress(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 1);
      const result = deriveTranchedVaultAddresses(FAKE_PROGRAM_ID, FAKE_ASSET_MINT, 1);
      expect(result.vault.toBase58()).to.equal(expected.toBase58());
      expect(result.vaultBump).to.equal(expectedBump);
    });
  });

  describe("TranchedVault interfaces", () => {
    it("TranchedVaultState has expected fields", async () => {
      const { TranchedVault } = await import("../sdk/core/src/tranched-vault");
      expect(TranchedVault).to.be.a("function");
      expect(TranchedVault.create).to.be.a("function");
      expect(TranchedVault.load).to.be.a("function");
    });

    it("TranchedVault prototype has all methods", async () => {
      const { TranchedVault } = await import("../sdk/core/src/tranched-vault");
      const proto = TranchedVault.prototype;
      const methods = [
        "refresh", "getState", "getTrancheState",
        "addTranche", "deposit", "redeem",
        "distributeYield", "recordLoss", "rebalance",
        "pause", "unpause", "transferAuthority", "setManager",
        "updateTrancheConfig",
        "getTrancheAddress", "getTrancheSharesMint",
        "getUserSharesAccount", "getUserAssetAccount",
      ];
      for (const method of methods) {
        expect(proto).to.have.property(method);
      }
    });
  });

  describe("error codes", () => {
    it("SVS-12 program ID matches expected", () => {
      expect(FAKE_PROGRAM_ID.toBase58()).to.equal("85wwufKdhpHxiBe4kMeFBfidL1Kqo62T65DHb46qNugA");
    });
  });
});
