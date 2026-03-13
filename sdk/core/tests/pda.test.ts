/** Tests for PDA derivation: vault and shares mint addresses */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  ASYNC_VAULT_SEED,
  CLAIMABLE_SEED,
  DEPOSIT_REQUEST_SEED,
  OPERATOR_APPROVAL_SEED,
  REDEEM_REQUEST_SEED,
  SHARE_ESCROW_SEED,
  deriveAsyncVaultAddresses,
  getAsyncVaultAddress,
  getClaimableEscrowAddress,
  getDepositRequestAddress,
  getOperatorApprovalAddress,
  getRedeemRequestAddress,
  getShareEscrowAddress,
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
  const OWNER = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const OPERATOR = new PublicKey(
    "Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC",
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

  describe("getAsyncVaultAddress", () => {
    it("derives deterministic async vault address", () => {
      const [vault1, bump1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2, bump2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);

      expect(vault1.equals(vault2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("differs from synchronous vault seed space", () => {
      const [syncVault] = getVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [asyncVault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);

      expect(syncVault.equals(asyncVault)).to.be.false;
    });
  });

  describe("async request-related PDAs", () => {
    it("derives deterministic share escrow address", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [escrow1, bump1] = getShareEscrowAddress(PROGRAM_ID, vault);
      const [escrow2, bump2] = getShareEscrowAddress(PROGRAM_ID, vault);

      expect(escrow1.equals(escrow2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("derives owner-scoped request PDAs", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [depositRequest] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);
      const [redeemRequest] = getRedeemRequestAddress(PROGRAM_ID, vault, OWNER);
      const [claimableEscrow] = getClaimableEscrowAddress(
        PROGRAM_ID,
        vault,
        OWNER,
      );

      expect(depositRequest.equals(redeemRequest)).to.be.false;
      expect(depositRequest.equals(claimableEscrow)).to.be.false;
      expect(redeemRequest.equals(claimableEscrow)).to.be.false;
    });

    it("derives operator approval using owner and operator", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [approval1, bump1] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );
      const [approval2, bump2] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );

      expect(approval1.equals(approval2)).to.be.true;
      expect(bump1).to.equal(bump2);
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

    it("async seed constants are correct", () => {
      expect(ASYNC_VAULT_SEED.toString()).to.equal("async_vault");
      expect(SHARE_ESCROW_SEED.toString()).to.equal("share_escrow");
      expect(DEPOSIT_REQUEST_SEED.toString()).to.equal("deposit_request");
      expect(REDEEM_REQUEST_SEED.toString()).to.equal("redeem_request");
      expect(CLAIMABLE_SEED.toString()).to.equal("claimable");
      expect(OPERATOR_APPROVAL_SEED.toString()).to.equal("operator_approval");
    });
  });

  describe("deriveAsyncVaultAddresses", () => {
    it("returns async vault, shares mint, and share escrow", () => {
      const addresses = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 9);

      expect(addresses.vault).to.be.instanceOf(PublicKey);
      expect(addresses.sharesMint).to.be.instanceOf(PublicKey);
      expect(addresses.shareEscrow).to.be.instanceOf(PublicKey);
      expect(addresses.vaultBump).to.be.a("number");
      expect(addresses.sharesMintBump).to.be.a("number");
      expect(addresses.shareEscrowBump).to.be.a("number");
    });
  });
});
