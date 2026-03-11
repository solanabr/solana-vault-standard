/** Tests for async vault PDA derivation: vault, shares mint, escrow, requests, operator */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getAsyncVaultAddress,
  getAsyncSharesMintAddress,
  getShareEscrowAddress,
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableTokensAddress,
  getOperatorApprovalAddress,
  deriveAsyncVaultAddresses,
  ASYNC_VAULT_SEED,
  ASYNC_SHARES_MINT_SEED,
  SHARE_ESCROW_SEED,
  DEPOSIT_REQUEST_SEED,
  REDEEM_REQUEST_SEED,
  CLAIMABLE_TOKENS_SEED,
  OPERATOR_APPROVAL_SEED,
} from "../src/async-vault-pda";

describe("SDK Async Vault PDA Module", () => {
  const PROGRAM_ID = new PublicKey(
    "SVS1111111111111111111111111111111111111111",
  );
  const ASSET_MINT = new PublicKey(
    "So11111111111111111111111111111111111111112",
  );
  const OTHER_MINT = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const OWNER = new PublicKey("11111111111111111111111111111111");
  const OPERATOR = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  describe("Seed constants", () => {
    it("ASYNC_VAULT_SEED is correct", () => {
      expect(ASYNC_VAULT_SEED.toString()).to.equal("vault");
    });

    it("ASYNC_SHARES_MINT_SEED is correct", () => {
      expect(ASYNC_SHARES_MINT_SEED.toString()).to.equal("shares");
    });

    it("SHARE_ESCROW_SEED is correct", () => {
      expect(SHARE_ESCROW_SEED.toString()).to.equal("share_escrow");
    });

    it("DEPOSIT_REQUEST_SEED is correct", () => {
      expect(DEPOSIT_REQUEST_SEED.toString()).to.equal("deposit_request");
    });

    it("REDEEM_REQUEST_SEED is correct", () => {
      expect(REDEEM_REQUEST_SEED.toString()).to.equal("redeem_request");
    });

    it("CLAIMABLE_TOKENS_SEED is correct", () => {
      expect(CLAIMABLE_TOKENS_SEED.toString()).to.equal("claimable_tokens");
    });

    it("OPERATOR_APPROVAL_SEED is correct", () => {
      expect(OPERATOR_APPROVAL_SEED.toString()).to.equal("operator_approval");
    });
  });

  describe("getAsyncVaultAddress", () => {
    it("derives deterministic vault address", () => {
      const [vault1, bump1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2, bump2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);

      expect(vault1.equals(vault2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different vault IDs produce different addresses", () => {
      const [vault1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 2);

      expect(vault1.equals(vault2)).to.be.false;
    });

    it("different asset mints produce different addresses", () => {
      const [vault1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getAsyncVaultAddress(PROGRAM_ID, OTHER_MINT, 1);

      expect(vault1.equals(vault2)).to.be.false;
    });

    it("accepts BN for vault_id with same result as number", () => {
      const [vaultNumber] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 42);
      const [vaultBN] = getAsyncVaultAddress(
        PROGRAM_ID,
        ASSET_MINT,
        new BN(42),
      );

      expect(vaultNumber.equals(vaultBN)).to.be.true;
    });

    it("handles large vault_id (u64::MAX)", () => {
      const largeId = new BN("18446744073709551615");
      const [vault, bump] = getAsyncVaultAddress(
        PROGRAM_ID,
        ASSET_MINT,
        largeId,
      );

      expect(vault).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
      expect(bump).to.be.lessThanOrEqual(255);
    });
  });

  describe("getAsyncSharesMintAddress", () => {
    it("derives deterministic shares mint address", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [mint1, bump1] = getAsyncSharesMintAddress(PROGRAM_ID, vault);
      const [mint2, bump2] = getAsyncSharesMintAddress(PROGRAM_ID, vault);

      expect(mint1.equals(mint2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different vaults produce different shares mints", () => {
      const [vault1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
      const [mint1] = getAsyncSharesMintAddress(PROGRAM_ID, vault1);
      const [mint2] = getAsyncSharesMintAddress(PROGRAM_ID, vault2);

      expect(mint1.equals(mint2)).to.be.false;
    });
  });

  describe("getShareEscrowAddress", () => {
    it("derives deterministic share escrow address", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [escrow1, bump1] = getShareEscrowAddress(PROGRAM_ID, vault);
      const [escrow2, bump2] = getShareEscrowAddress(PROGRAM_ID, vault);

      expect(escrow1.equals(escrow2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different vaults produce different escrows", () => {
      const [vault1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
      const [escrow1] = getShareEscrowAddress(PROGRAM_ID, vault1);
      const [escrow2] = getShareEscrowAddress(PROGRAM_ID, vault2);

      expect(escrow1.equals(escrow2)).to.be.false;
    });
  });

  describe("getDepositRequestAddress", () => {
    it("derives deterministic deposit request address", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [req1, bump1] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);
      const [req2, bump2] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);

      expect(req1.equals(req2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different owners produce different PDAs", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [req1] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);
      const [req2] = getDepositRequestAddress(PROGRAM_ID, vault, OPERATOR);

      expect(req1.equals(req2)).to.be.false;
    });

    it("different vaults produce different PDAs", () => {
      const [vault1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
      const [req1] = getDepositRequestAddress(PROGRAM_ID, vault1, OWNER);
      const [req2] = getDepositRequestAddress(PROGRAM_ID, vault2, OWNER);

      expect(req1.equals(req2)).to.be.false;
    });
  });

  describe("getRedeemRequestAddress", () => {
    it("derives deterministic redeem request address", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [req1, bump1] = getRedeemRequestAddress(PROGRAM_ID, vault, OWNER);
      const [req2, bump2] = getRedeemRequestAddress(PROGRAM_ID, vault, OWNER);

      expect(req1.equals(req2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different owners produce different PDAs", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [req1] = getRedeemRequestAddress(PROGRAM_ID, vault, OWNER);
      const [req2] = getRedeemRequestAddress(PROGRAM_ID, vault, OPERATOR);

      expect(req1.equals(req2)).to.be.false;
    });

    it("different vaults produce different PDAs", () => {
      const [vault1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
      const [req1] = getRedeemRequestAddress(PROGRAM_ID, vault1, OWNER);
      const [req2] = getRedeemRequestAddress(PROGRAM_ID, vault2, OWNER);

      expect(req1.equals(req2)).to.be.false;
    });
  });

  describe("getClaimableTokensAddress", () => {
    it("derives deterministic claimable tokens address", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [ct1, bump1] = getClaimableTokensAddress(PROGRAM_ID, vault, OWNER);
      const [ct2, bump2] = getClaimableTokensAddress(PROGRAM_ID, vault, OWNER);

      expect(ct1.equals(ct2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different owners produce different PDAs", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [ct1] = getClaimableTokensAddress(PROGRAM_ID, vault, OWNER);
      const [ct2] = getClaimableTokensAddress(PROGRAM_ID, vault, OPERATOR);

      expect(ct1.equals(ct2)).to.be.false;
    });
  });

  describe("getOperatorApprovalAddress", () => {
    it("derives deterministic operator approval address", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [oa1, bump1] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );
      const [oa2, bump2] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );

      expect(oa1.equals(oa2)).to.be.true;
      expect(bump1).to.equal(bump2);
    });

    it("different (owner, operator) pairs produce unique PDAs", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const thirdKey = new PublicKey(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      );
      const [oa1] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );
      const [oa2] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        thirdKey,
      );

      expect(oa1.equals(oa2)).to.be.false;
    });

    it("swapping owner and operator produces different address", () => {
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [oa1] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );
      const [oa2] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OPERATOR,
        OWNER,
      );

      expect(oa1.equals(oa2)).to.be.false;
    });
  });

  describe("deriveAsyncVaultAddresses", () => {
    it("returns all fields with correct types", () => {
      const addresses = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);

      expect(addresses.vault).to.be.instanceOf(PublicKey);
      expect(addresses.sharesMint).to.be.instanceOf(PublicKey);
      expect(addresses.shareEscrow).to.be.instanceOf(PublicKey);
      expect(addresses.vaultBump).to.be.a("number");
      expect(addresses.sharesMintBump).to.be.a("number");
      expect(addresses.shareEscrowBump).to.be.a("number");
    });

    it("matches individual derivation results", () => {
      const addresses = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);
      const [vault, vaultBump] = getAsyncVaultAddress(
        PROGRAM_ID,
        ASSET_MINT,
        1,
      );
      const [sharesMint, sharesMintBump] = getAsyncSharesMintAddress(
        PROGRAM_ID,
        vault,
      );
      const [shareEscrow, shareEscrowBump] = getShareEscrowAddress(
        PROGRAM_ID,
        vault,
      );

      expect(addresses.vault.equals(vault)).to.be.true;
      expect(addresses.vaultBump).to.equal(vaultBump);
      expect(addresses.sharesMint.equals(sharesMint)).to.be.true;
      expect(addresses.sharesMintBump).to.equal(sharesMintBump);
      expect(addresses.shareEscrow.equals(shareEscrow)).to.be.true;
      expect(addresses.shareEscrowBump).to.equal(shareEscrowBump);
    });

    it("all bumps are valid (0-255)", () => {
      const addresses = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);

      expect(addresses.vaultBump).to.be.lessThanOrEqual(255);
      expect(addresses.sharesMintBump).to.be.lessThanOrEqual(255);
      expect(addresses.shareEscrowBump).to.be.lessThanOrEqual(255);
      expect(addresses.vaultBump).to.be.greaterThanOrEqual(0);
      expect(addresses.sharesMintBump).to.be.greaterThanOrEqual(0);
      expect(addresses.shareEscrowBump).to.be.greaterThanOrEqual(0);
    });
  });
});
