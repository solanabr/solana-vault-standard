import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getVaultAddress,
  getSharesMintAddress,
  deriveVaultAddresses,
  VAULT_SEED,
  SHARES_MINT_SEED,
} from "../src/pda";

describe("SDK PDA Module", () => {
  const PROGRAM_ID = new PublicKey(
    "SVS1111111111111111111111111111111111111111",
  );
  const ASSET_MINT = new PublicKey(
    "So11111111111111111111111111111111111111112",
  );

  describe("getVaultAddress", () => {
    it("derives deterministic vault address", () => {
      const [vault1, bump1] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2, bump2] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 1);

      expect(vault1.equals(vault2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different vault_ids produce different addresses", () => {
      const [vault1] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 2);

      expect(vault1.equals(vault2)).to.be.false;
    });

    it("different asset mints produce different addresses", () => {
      const otherMint = new PublicKey(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
      const [vault1] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getVaultAddress(PROGRAM_ID, otherMint, 1);

      expect(vault1.equals(vault2)).to.be.false;
    });

    it("accepts BN for vault_id", () => {
      const [vaultNumber] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 42);
      const [vaultBN] = getVaultAddress(PROGRAM_ID, ASSET_MINT, new BN(42));

      expect(vaultNumber.equals(vaultBN)).to.be.true;
    });

    it("handles large vault_id", () => {
      const largeId = new BN("18446744073709551615"); // u64::MAX
      const [vault, bump] = getVaultAddress(PROGRAM_ID, ASSET_MINT, largeId);

      expect(vault).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
      expect(bump).to.be.lessThanOrEqual(255);
    });
  });

  describe("getSharesMintAddress", () => {
    it("derives deterministic shares mint address", () => {
      const [vault] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [sharesMint1, bump1] = getSharesMintAddress(PROGRAM_ID, vault);
      const [sharesMint2, bump2] = getSharesMintAddress(PROGRAM_ID, vault);

      expect(sharesMint1.equals(sharesMint2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different vaults produce different shares mints", () => {
      const [vault1] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
      const [sharesMint1] = getSharesMintAddress(PROGRAM_ID, vault1);
      const [sharesMint2] = getSharesMintAddress(PROGRAM_ID, vault2);

      expect(sharesMint1.equals(sharesMint2)).to.be.false;
    });
  });

  describe("deriveVaultAddresses", () => {
    it("returns all addresses consistently", () => {
      const addresses = deriveVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);

      expect(addresses.vault).to.be.instanceOf(PublicKey);
      expect(addresses.sharesMint).to.be.instanceOf(PublicKey);
      expect(addresses.vaultBump).to.be.a("number");
      expect(addresses.sharesMintBump).to.be.a("number");
    });

    it("matches individual derivations", () => {
      const addresses = deriveVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);
      const [vault, vaultBump] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [sharesMint, sharesMintBump] = getSharesMintAddress(
        PROGRAM_ID,
        vault,
      );

      expect(addresses.vault.equals(vault)).to.be.true;
      expect(addresses.vaultBump).to.equal(vaultBump);
      expect(addresses.sharesMint.equals(sharesMint)).to.be.true;
      expect(addresses.sharesMintBump).to.equal(sharesMintBump);
    });
  });

  describe("Seed constants", () => {
    it("VAULT_SEED is correct", () => {
      expect(VAULT_SEED.toString()).to.equal("vault");
    });

    it("SHARES_MINT_SEED is correct", () => {
      expect(SHARES_MINT_SEED.toString()).to.equal("shares");
    });
  });
});
