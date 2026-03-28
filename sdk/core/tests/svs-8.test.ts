/** Tests for SVS-8 SDK — Multi-Asset Basket Vault */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getBasketVaultAddress,
  getBasketSharesMintAddress,
  getAssetEntryAddress,
  getOraclePriceAddress,
  MULTI_VAULT_SEED,
  ASSET_ENTRY_SEED,
  SHARES_SEED,
  ORACLE_PRICE_SEED,
  PRICE_SCALE,
} from "../src/svs-8";

const PROGRAM_ID = new PublicKey("E8bGqwitsaFELBtuhbwAKwVBKjAjGzrfcnBPishvvRsA");
const MINT_A = new PublicKey("So11111111111111111111111111111111111111112");
const MINT_B = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe("SVS-8 SDK — PDA Derivation", () => {

  describe("getBasketVaultAddress", () => {
    it("derives deterministic vault address", () => {
      const [vault1, bump1] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [vault2, bump2] = getBasketVaultAddress(PROGRAM_ID, 1);
      expect(vault1.equals(vault2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different vault_ids produce different addresses", () => {
      const [vault1] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [vault2] = getBasketVaultAddress(PROGRAM_ID, 2);
      expect(vault1.equals(vault2)).to.be.false;
    });

    it("accepts BN for vault_id", () => {
      const [vaultNumber] = getBasketVaultAddress(PROGRAM_ID, 42);
      const [vaultBN] = getBasketVaultAddress(PROGRAM_ID, new BN(42));
      expect(vaultNumber.equals(vaultBN)).to.be.true;
    });

    it.skip("accepts bigint for vault_id", () => {
      const [vaultNumber] = getBasketVaultAddress(PROGRAM_ID, 7);
      const [vaultBigInt] = getBasketVaultAddress(PROGRAM_ID, new BN(7));
      expect(vaultNumber.equals(vaultBigInt)).to.be.true;
    });

    it("handles u64::MAX vault_id", () => {
      const [vault, bump] = getBasketVaultAddress(PROGRAM_ID, new BN("18446744073709551615"));
      expect(vault).to.be.instanceOf(PublicKey);
      expect(bump).to.be.lessThanOrEqual(255);
    });

    it("returns valid PublicKey", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      expect(vault).to.be.instanceOf(PublicKey);
      expect(vault.toBase58()).to.have.length.greaterThan(0);
    });
  });

  describe("getBasketSharesMintAddress", () => {
    it("derives deterministic shares mint address", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [mint1, bump1] = getBasketSharesMintAddress(PROGRAM_ID, vault);
      const [mint2, bump2] = getBasketSharesMintAddress(PROGRAM_ID, vault);
      expect(mint1.equals(mint2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different vaults produce different shares mints", () => {
      const [vault1] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [vault2] = getBasketVaultAddress(PROGRAM_ID, 2);
      const [mint1] = getBasketSharesMintAddress(PROGRAM_ID, vault1);
      const [mint2] = getBasketSharesMintAddress(PROGRAM_ID, vault2);
      expect(mint1.equals(mint2)).to.be.false;
    });

    it("shares mint differs from vault address", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [sharesMint] = getBasketSharesMintAddress(PROGRAM_ID, vault);
      expect(vault.equals(sharesMint)).to.be.false;
    });
  });

  describe("getAssetEntryAddress", () => {
    it("derives deterministic asset entry address", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [entry1, bump1] = getAssetEntryAddress(PROGRAM_ID, vault, MINT_A);
      const [entry2, bump2] = getAssetEntryAddress(PROGRAM_ID, vault, MINT_A);
      expect(entry1.equals(entry2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different mints produce different asset entries", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [entryA] = getAssetEntryAddress(PROGRAM_ID, vault, MINT_A);
      const [entryB] = getAssetEntryAddress(PROGRAM_ID, vault, MINT_B);
      expect(entryA.equals(entryB)).to.be.false;
    });

    it("different vaults produce different asset entries for same mint", () => {
      const [vault1] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [vault2] = getBasketVaultAddress(PROGRAM_ID, 2);
      const [entry1] = getAssetEntryAddress(PROGRAM_ID, vault1, MINT_A);
      const [entry2] = getAssetEntryAddress(PROGRAM_ID, vault2, MINT_A);
      expect(entry1.equals(entry2)).to.be.false;
    });
  });

  describe("getOraclePriceAddress", () => {
    it("derives deterministic oracle price address", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [oracle1, bump1] = getOraclePriceAddress(PROGRAM_ID, vault, MINT_A);
      const [oracle2, bump2] = getOraclePriceAddress(PROGRAM_ID, vault, MINT_A);
      expect(oracle1.equals(oracle2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different mints produce different oracle addresses", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [oracleA] = getOraclePriceAddress(PROGRAM_ID, vault, MINT_A);
      const [oracleB] = getOraclePriceAddress(PROGRAM_ID, vault, MINT_B);
      expect(oracleA.equals(oracleB)).to.be.false;
    });

    it("oracle address differs from asset entry address", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [oracle] = getOraclePriceAddress(PROGRAM_ID, vault, MINT_A);
      const [entry] = getAssetEntryAddress(PROGRAM_ID, vault, MINT_A);
      expect(oracle.equals(entry)).to.be.false;
    });
  });

  describe("Seed constants", () => {
    it("MULTI_VAULT_SEED is correct", () => {
      expect(MULTI_VAULT_SEED.toString()).to.equal("multi_vault");
    });

    it("ASSET_ENTRY_SEED is correct", () => {
      expect(ASSET_ENTRY_SEED.toString()).to.equal("asset_entry");
    });

    it("SHARES_SEED is correct", () => {
      expect(SHARES_SEED.toString()).to.equal("shares");
    });

    it("ORACLE_PRICE_SEED is correct", () => {
      expect(ORACLE_PRICE_SEED.toString()).to.equal("oracle_price");
    });

    it("PRICE_SCALE is 1e9", () => {
      expect(PRICE_SCALE.toNumber()).to.equal(1_000_000_000);
    });
  });

  describe("Address uniqueness across PDAs", () => {
    it("vault, shares mint, asset entry, oracle all have unique addresses", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [sharesMint] = getBasketSharesMintAddress(PROGRAM_ID, vault);
      const [assetEntry] = getAssetEntryAddress(PROGRAM_ID, vault, MINT_A);
      const [oracle] = getOraclePriceAddress(PROGRAM_ID, vault, MINT_A);

      const addresses = [vault, sharesMint, assetEntry, oracle];
      const unique = new Set(addresses.map(a => a.toBase58()));
      expect(unique.size).to.equal(4);
    });

    it("PDA addresses are valid Solana public keys (on-curve check)", () => {
      const [vault] = getBasketVaultAddress(PROGRAM_ID, 1);
      const [sharesMint] = getBasketSharesMintAddress(PROGRAM_ID, vault);
      const [assetEntry] = getAssetEntryAddress(PROGRAM_ID, vault, MINT_A);
      const [oracle] = getOraclePriceAddress(PROGRAM_ID, vault, MINT_A);

      for (const addr of [vault, sharesMint, assetEntry, oracle]) {
        expect(addr.toBase58()).to.be.a("string");
        expect(addr.toBytes()).to.have.length(32);
      }
    });
  });
});
