import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getCreditVaultAddress,
  getCreditSharesMintAddress,
  getDepositVaultAddress,
  getRedemptionEscrowAddress,
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableEscrowAddress,
  getClaimableTokensAddress,
  getFrozenAccountAddress,
  deriveCreditVaultAddresses,
  CREDIT_VAULT_SEED,
  CREDIT_SHARES_MINT_SEED,
  DEPOSIT_VAULT_SEED,
  REDEMPTION_ESCROW_SEED,
  INVESTMENT_REQUEST_SEED,
  REDEMPTION_REQUEST_SEED,
  CLAIMABLE_SEED,
  CLAIMABLE_TOKENS_SEED,
  FROZEN_ACCOUNT_SEED,
} from "../src/credit-pda";

const PROGRAM_ID = new PublicKey("SVS8w4PozVex3B2RWbPJDjvacZaWZm4xaCwbtZb1dqA");
const ASSET_MINT = PublicKey.unique();
const INVESTOR = PublicKey.unique();
const VAULT_ID = new BN(1);

describe("credit-pda", () => {
  describe("seed constants", () => {
    it("has correct seed values", () => {
      expect(CREDIT_VAULT_SEED.toString()).to.equal("credit_vault");
      expect(CREDIT_SHARES_MINT_SEED.toString()).to.equal("shares");
      expect(DEPOSIT_VAULT_SEED.toString()).to.equal("deposit_vault");
      expect(REDEMPTION_ESCROW_SEED.toString()).to.equal("redemption_escrow");
      expect(INVESTMENT_REQUEST_SEED.toString()).to.equal("investment_request");
      expect(REDEMPTION_REQUEST_SEED.toString()).to.equal("redemption_request");
      expect(CLAIMABLE_SEED.toString()).to.equal("claimable");
      expect(CLAIMABLE_TOKENS_SEED.toString()).to.equal("claimable_tokens");
      expect(FROZEN_ACCOUNT_SEED.toString()).to.equal("frozen_account");
    });
  });

  describe("getCreditVaultAddress", () => {
    it("derives deterministic address", () => {
      const [addr1] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, VAULT_ID);
      const [addr2] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, VAULT_ID);
      expect(addr1.equals(addr2)).to.be.true;
    });

    it("different vault IDs produce different addresses", () => {
      const [addr1] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [addr2] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
      expect(addr1.equals(addr2)).to.be.false;
    });

    it("different mints produce different addresses", () => {
      const [addr1] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [addr2] = getCreditVaultAddress(PROGRAM_ID, PublicKey.unique(), 1);
      expect(addr1.equals(addr2)).to.be.false;
    });

    it("accepts number vault ID", () => {
      const [addr1] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 5);
      const [addr2] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, new BN(5));
      expect(addr1.equals(addr2)).to.be.true;
    });

    it("returns valid bump", () => {
      const [, bump] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      expect(bump).to.be.a("number");
      expect(bump).to.be.at.least(0);
      expect(bump).to.be.at.most(255);
    });
  });

  describe("getCreditSharesMintAddress", () => {
    it("derives from vault key", () => {
      const [vault] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [shares1] = getCreditSharesMintAddress(PROGRAM_ID, vault);
      const [shares2] = getCreditSharesMintAddress(PROGRAM_ID, vault);
      expect(shares1.equals(shares2)).to.be.true;
    });
  });

  describe("getDepositVaultAddress", () => {
    it("derives from vault key", () => {
      const [vault] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [dv] = getDepositVaultAddress(PROGRAM_ID, vault);
      expect(dv).to.be.instanceOf(PublicKey);
    });
  });

  describe("getRedemptionEscrowAddress", () => {
    it("derives from vault key", () => {
      const [vault] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [re] = getRedemptionEscrowAddress(PROGRAM_ID, vault);
      expect(re).to.be.instanceOf(PublicKey);
    });
  });

  describe("investor-scoped PDAs", () => {
    let vault: PublicKey;

    before(() => {
      [vault] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
    });

    it("getInvestmentRequestAddress is deterministic", () => {
      const [addr1] = getInvestmentRequestAddress(PROGRAM_ID, vault, INVESTOR);
      const [addr2] = getInvestmentRequestAddress(PROGRAM_ID, vault, INVESTOR);
      expect(addr1.equals(addr2)).to.be.true;
    });

    it("different investors produce different investment request addresses", () => {
      const [addr1] = getInvestmentRequestAddress(PROGRAM_ID, vault, INVESTOR);
      const [addr2] = getInvestmentRequestAddress(
        PROGRAM_ID,
        vault,
        PublicKey.unique(),
      );
      expect(addr1.equals(addr2)).to.be.false;
    });

    it("getRedemptionRequestAddress is deterministic", () => {
      const [addr1] = getRedemptionRequestAddress(PROGRAM_ID, vault, INVESTOR);
      const [addr2] = getRedemptionRequestAddress(PROGRAM_ID, vault, INVESTOR);
      expect(addr1.equals(addr2)).to.be.true;
    });

    it("getClaimableEscrowAddress is deterministic", () => {
      const [addr1] = getClaimableEscrowAddress(PROGRAM_ID, vault, INVESTOR);
      const [addr2] = getClaimableEscrowAddress(PROGRAM_ID, vault, INVESTOR);
      expect(addr1.equals(addr2)).to.be.true;
    });

    it("getClaimableTokensAddress is deterministic", () => {
      const [addr1] = getClaimableTokensAddress(PROGRAM_ID, vault, INVESTOR);
      const [addr2] = getClaimableTokensAddress(PROGRAM_ID, vault, INVESTOR);
      expect(addr1.equals(addr2)).to.be.true;
    });

    it("getFrozenAccountAddress is deterministic", () => {
      const [addr1] = getFrozenAccountAddress(PROGRAM_ID, vault, INVESTOR);
      const [addr2] = getFrozenAccountAddress(PROGRAM_ID, vault, INVESTOR);
      expect(addr1.equals(addr2)).to.be.true;
    });

    it("all investor-scoped PDAs are unique per address type", () => {
      const [ir] = getInvestmentRequestAddress(PROGRAM_ID, vault, INVESTOR);
      const [rr] = getRedemptionRequestAddress(PROGRAM_ID, vault, INVESTOR);
      const [ce] = getClaimableEscrowAddress(PROGRAM_ID, vault, INVESTOR);
      const [ct] = getClaimableTokensAddress(PROGRAM_ID, vault, INVESTOR);
      const [fa] = getFrozenAccountAddress(PROGRAM_ID, vault, INVESTOR);

      const addresses = [ir, rr, ce, ct, fa].map((a) => a.toBase58());
      const unique = new Set(addresses);
      expect(unique.size).to.equal(5);
    });
  });

  describe("deriveCreditVaultAddresses", () => {
    it("returns all vault-level addresses", () => {
      const result = deriveCreditVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);

      expect(result.vault).to.be.instanceOf(PublicKey);
      expect(result.sharesMint).to.be.instanceOf(PublicKey);
      expect(result.depositVault).to.be.instanceOf(PublicKey);
      expect(result.redemptionEscrow).to.be.instanceOf(PublicKey);
      expect(result.vaultBump).to.be.a("number");
      expect(result.sharesMintBump).to.be.a("number");
      expect(result.depositVaultBump).to.be.a("number");
      expect(result.redemptionEscrowBump).to.be.a("number");
    });

    it("matches individual derivations", () => {
      const batch = deriveCreditVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);
      const [vault] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [shares] = getCreditSharesMintAddress(PROGRAM_ID, vault);
      const [dv] = getDepositVaultAddress(PROGRAM_ID, vault);
      const [re] = getRedemptionEscrowAddress(PROGRAM_ID, vault);

      expect(batch.vault.equals(vault)).to.be.true;
      expect(batch.sharesMint.equals(shares)).to.be.true;
      expect(batch.depositVault.equals(dv)).to.be.true;
      expect(batch.redemptionEscrow.equals(re)).to.be.true;
    });

    it("all batch addresses are unique", () => {
      const r = deriveCreditVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);
      const addrs = [
        r.vault,
        r.sharesMint,
        r.depositVault,
        r.redemptionEscrow,
      ].map((a) => a.toBase58());
      expect(new Set(addrs).size).to.equal(4);
    });
  });
});
