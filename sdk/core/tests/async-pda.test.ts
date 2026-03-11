/** Tests for async vault PDA derivation functions */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getAsyncVaultAddress,
  getAsyncSharesMintAddress,
  getAssetVaultAddress,
  getShareEscrowAddress,
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableEscrowAddress,
  getClaimableTokensAddress,
  getOperatorApprovalAddress,
  deriveAsyncVaultAddresses,
  ASYNC_VAULT_SEED,
  ASYNC_SHARES_MINT_SEED,
  ASSET_VAULT_SEED,
  SHARE_ESCROW_SEED,
  DEPOSIT_REQUEST_SEED,
  REDEEM_REQUEST_SEED,
  CLAIMABLE_SEED,
  CLAIMABLE_TOKENS_SEED,
  OPERATOR_APPROVAL_SEED,
} from "../src/async-pda";

describe("Async PDA Module", () => {
  const PROGRAM_ID = new PublicKey(
    "149FyatCNUNW8FnfU6D4zBvieANZ7BEyFwDDA2wo96G9",
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
    it("has correct seed values", () => {
      expect(ASYNC_VAULT_SEED.toString()).to.equal("async_vault");
      expect(ASYNC_SHARES_MINT_SEED.toString()).to.equal("shares");
      expect(ASSET_VAULT_SEED.toString()).to.equal("asset_vault");
      expect(SHARE_ESCROW_SEED.toString()).to.equal("share_escrow");
      expect(DEPOSIT_REQUEST_SEED.toString()).to.equal("deposit_request");
      expect(REDEEM_REQUEST_SEED.toString()).to.equal("redeem_request");
      expect(CLAIMABLE_SEED.toString()).to.equal("claimable");
      expect(CLAIMABLE_TOKENS_SEED.toString()).to.equal("claimable_tokens");
      expect(OPERATOR_APPROVAL_SEED.toString()).to.equal("operator_approval");
    });
  });

  describe("getAsyncVaultAddress", () => {
    it("derives deterministic address", () => {
      const [v1, b1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [v2, b2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      expect(v1.equals(v2)).to.be.true;
      expect(b1).to.equal(b2);
    });

    it("different vault_ids produce different addresses", () => {
      const [v1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [v2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
      expect(v1.equals(v2)).to.be.false;
    });

    it("different asset mints produce different addresses", () => {
      const [v1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [v2] = getAsyncVaultAddress(PROGRAM_ID, OTHER_MINT, 1);
      expect(v1.equals(v2)).to.be.false;
    });

    it("accepts BN for vault_id", () => {
      const [v1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 42);
      const [v2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, new BN(42));
      expect(v1.equals(v2)).to.be.true;
    });

    it("handles u64::MAX vault_id", () => {
      const maxId = new BN("18446744073709551615");
      const [vault, bump] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, maxId);
      expect(vault).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number").and.to.be.lessThanOrEqual(255);
    });

    it("vault_id 0 works", () => {
      const [vault, bump] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 0);
      expect(vault).to.be.instanceOf(PublicKey);
      expect(bump).to.be.a("number");
    });
  });

  describe("Vault-derived PDAs", () => {
    let vault: PublicKey;

    before(() => {
      [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
    });

    it("getAsyncSharesMintAddress is deterministic", () => {
      const [m1, b1] = getAsyncSharesMintAddress(PROGRAM_ID, vault);
      const [m2, b2] = getAsyncSharesMintAddress(PROGRAM_ID, vault);
      expect(m1.equals(m2)).to.be.true;
      expect(b1).to.equal(b2);
    });

    it("getAssetVaultAddress is deterministic", () => {
      const [a1] = getAssetVaultAddress(PROGRAM_ID, vault);
      const [a2] = getAssetVaultAddress(PROGRAM_ID, vault);
      expect(a1.equals(a2)).to.be.true;
    });

    it("getShareEscrowAddress is deterministic", () => {
      const [s1] = getShareEscrowAddress(PROGRAM_ID, vault);
      const [s2] = getShareEscrowAddress(PROGRAM_ID, vault);
      expect(s1.equals(s2)).to.be.true;
    });

    it("different vaults produce different derived addresses", () => {
      const [vault2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
      const [sm1] = getAsyncSharesMintAddress(PROGRAM_ID, vault);
      const [sm2] = getAsyncSharesMintAddress(PROGRAM_ID, vault2);
      expect(sm1.equals(sm2)).to.be.false;
    });
  });

  describe("Per-user PDAs", () => {
    let vault: PublicKey;

    before(() => {
      [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
    });

    it("getDepositRequestAddress is deterministic", () => {
      const [d1] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);
      const [d2] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);
      expect(d1.equals(d2)).to.be.true;
    });

    it("different owners produce different deposit requests", () => {
      const [d1] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);
      const [d2] = getDepositRequestAddress(PROGRAM_ID, vault, OPERATOR);
      expect(d1.equals(d2)).to.be.false;
    });

    it("getRedeemRequestAddress is deterministic", () => {
      const [r1] = getRedeemRequestAddress(PROGRAM_ID, vault, OWNER);
      const [r2] = getRedeemRequestAddress(PROGRAM_ID, vault, OWNER);
      expect(r1.equals(r2)).to.be.true;
    });

    it("deposit and redeem requests are different PDAs", () => {
      const [dep] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);
      const [red] = getRedeemRequestAddress(PROGRAM_ID, vault, OWNER);
      expect(dep.equals(red)).to.be.false;
    });

    it("getClaimableEscrowAddress is deterministic", () => {
      const [c1] = getClaimableEscrowAddress(PROGRAM_ID, vault, OWNER);
      const [c2] = getClaimableEscrowAddress(PROGRAM_ID, vault, OWNER);
      expect(c1.equals(c2)).to.be.true;
    });

    it("getClaimableTokensAddress is deterministic", () => {
      const [t1] = getClaimableTokensAddress(PROGRAM_ID, vault, OWNER);
      const [t2] = getClaimableTokensAddress(PROGRAM_ID, vault, OWNER);
      expect(t1.equals(t2)).to.be.true;
    });

    it("claimable escrow and tokens are different PDAs", () => {
      const [esc] = getClaimableEscrowAddress(PROGRAM_ID, vault, OWNER);
      const [tok] = getClaimableTokensAddress(PROGRAM_ID, vault, OWNER);
      expect(esc.equals(tok)).to.be.false;
    });
  });

  describe("getOperatorApprovalAddress", () => {
    let vault: PublicKey;

    before(() => {
      [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
    });

    it("is deterministic", () => {
      const [a1] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );
      const [a2] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );
      expect(a1.equals(a2)).to.be.true;
    });

    it("different operators produce different approvals", () => {
      const other = new PublicKey(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      );
      const [a1] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );
      const [a2] = getOperatorApprovalAddress(PROGRAM_ID, vault, OWNER, other);
      expect(a1.equals(a2)).to.be.false;
    });

    it("different owners produce different approvals", () => {
      const [a1] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );
      const [a2] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OPERATOR,
        OPERATOR,
      );
      expect(a1.equals(a2)).to.be.false;
    });
  });

  describe("deriveAsyncVaultAddresses", () => {
    it("returns all core addresses", () => {
      const addrs = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);

      expect(addrs.vault).to.be.instanceOf(PublicKey);
      expect(addrs.sharesMint).to.be.instanceOf(PublicKey);
      expect(addrs.assetVault).to.be.instanceOf(PublicKey);
      expect(addrs.shareEscrow).to.be.instanceOf(PublicKey);
      expect(addrs.vaultBump).to.be.a("number");
      expect(addrs.sharesMintBump).to.be.a("number");
      expect(addrs.assetVaultBump).to.be.a("number");
      expect(addrs.shareEscrowBump).to.be.a("number");
    });

    it("matches individual derivations", () => {
      const addrs = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);
      const [vault, vaultBump] = getAsyncVaultAddress(
        PROGRAM_ID,
        ASSET_MINT,
        1,
      );
      const [sharesMint, sharesMintBump] = getAsyncSharesMintAddress(
        PROGRAM_ID,
        vault,
      );
      const [assetVault, assetVaultBump] = getAssetVaultAddress(
        PROGRAM_ID,
        vault,
      );
      const [shareEscrow, shareEscrowBump] = getShareEscrowAddress(
        PROGRAM_ID,
        vault,
      );

      expect(addrs.vault.equals(vault)).to.be.true;
      expect(addrs.vaultBump).to.equal(vaultBump);
      expect(addrs.sharesMint.equals(sharesMint)).to.be.true;
      expect(addrs.sharesMintBump).to.equal(sharesMintBump);
      expect(addrs.assetVault.equals(assetVault)).to.be.true;
      expect(addrs.assetVaultBump).to.equal(assetVaultBump);
      expect(addrs.shareEscrow.equals(shareEscrow)).to.be.true;
      expect(addrs.shareEscrowBump).to.equal(shareEscrowBump);
    });

    it("accepts BN vault_id", () => {
      const a1 = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 5);
      const a2 = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, new BN(5));
      expect(a1.vault.equals(a2.vault)).to.be.true;
    });
  });

  describe("Cross-vault isolation", () => {
    it("all per-user PDAs differ across vaults", () => {
      const [vault1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [vault2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 2);

      const [dep1] = getDepositRequestAddress(PROGRAM_ID, vault1, OWNER);
      const [dep2] = getDepositRequestAddress(PROGRAM_ID, vault2, OWNER);
      expect(dep1.equals(dep2)).to.be.false;

      const [red1] = getRedeemRequestAddress(PROGRAM_ID, vault1, OWNER);
      const [red2] = getRedeemRequestAddress(PROGRAM_ID, vault2, OWNER);
      expect(red1.equals(red2)).to.be.false;

      const [ce1] = getClaimableEscrowAddress(PROGRAM_ID, vault1, OWNER);
      const [ce2] = getClaimableEscrowAddress(PROGRAM_ID, vault2, OWNER);
      expect(ce1.equals(ce2)).to.be.false;

      const [ct1] = getClaimableTokensAddress(PROGRAM_ID, vault1, OWNER);
      const [ct2] = getClaimableTokensAddress(PROGRAM_ID, vault2, OWNER);
      expect(ct1.equals(ct2)).to.be.false;

      const [oa1] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault1,
        OWNER,
        OPERATOR,
      );
      const [oa2] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault2,
        OWNER,
        OPERATOR,
      );
      expect(oa1.equals(oa2)).to.be.false;
    });
  });
});
