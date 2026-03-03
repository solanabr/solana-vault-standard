import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  EmergencyConfig,
  EmergencyDenialReason,
  calculateEmergencyPenalty,
  previewEmergencyRedeem,
  previewEmergencyWithdraw,
  canEmergencyWithdraw,
  getEmergencyStatus,
  createEmergencyConfig,
  validateEmergencyConfig,
} from "../src/emergency";

describe("SDK Emergency Module", () => {
  const PENALTY_RECIPIENT = Keypair.generate().publicKey;

  const defaultConfig: EmergencyConfig = {
    penaltyBps: 500, // 5%
    minPenalty: new BN(1_000_000), // 1 USDC minimum
    maxPenalty: new BN(1_000_000_000_000), // 1M USDC maximum
    cooldownPeriod: 3600, // 1 hour
    penaltyRecipient: PENALTY_RECIPIENT,
  };

  const ONE_MILLION = new BN(1_000_000_000_000); // 1M USDC
  const HUNDRED_K = new BN(100_000_000_000); // 100K USDC

  describe("calculateEmergencyPenalty", () => {
    it("calculates percentage-based penalty", () => {
      const assets = new BN(1_000_000_000); // 1000 USDC
      const penalty = calculateEmergencyPenalty(assets, defaultConfig);

      // 5% of 1000 = 50 USDC
      expect(penalty.toNumber()).to.equal(50_000_000);
    });

    it("enforces minimum penalty", () => {
      const config = createEmergencyConfig(500, PENALTY_RECIPIENT, {
        minPenalty: new BN(10_000_000), // 10 USDC minimum
      });
      const assets = new BN(100_000_000); // 100 USDC

      const penalty = calculateEmergencyPenalty(assets, config);

      // 5% of 100 = 5, but min is 10
      expect(penalty.toNumber()).to.equal(10_000_000);
    });

    it("enforces maximum penalty cap", () => {
      const config = createEmergencyConfig(500, PENALTY_RECIPIENT, {
        maxPenalty: new BN(1_000_000_000), // 1000 USDC maximum
      });
      const assets = new BN(100_000_000_000); // 100K USDC

      const penalty = calculateEmergencyPenalty(assets, config);

      // 5% of 100K = 5000, but max is 1000
      expect(penalty.toNumber()).to.equal(1_000_000_000);
    });

    it("returns zero for zero assets", () => {
      const penalty = calculateEmergencyPenalty(new BN(0), defaultConfig);
      expect(penalty.toNumber()).to.equal(0);
    });

    it("returns zero for zero penalty rate", () => {
      const config = createEmergencyConfig(0, PENALTY_RECIPIENT);
      const penalty = calculateEmergencyPenalty(ONE_MILLION, config);
      expect(penalty.toNumber()).to.equal(0);
    });

    it("caps penalty at asset amount", () => {
      const config = createEmergencyConfig(10000, PENALTY_RECIPIENT, {
        minPenalty: new BN(100_000_000_000), // 100K minimum
      });
      const assets = new BN(10_000_000); // 10 USDC

      const penalty = calculateEmergencyPenalty(assets, config);

      // Penalty would be 100K, but assets only 10, so penalty = assets
      expect(penalty.toNumber()).to.equal(10_000_000);
    });
  });

  describe("previewEmergencyRedeem", () => {
    it("calculates correct net assets after penalty", () => {
      const shares = new BN(1_000_000_000_000_000); // 1M shares
      const totalAssets = ONE_MILLION;
      const totalShares = shares;
      const decimalsOffset = 3;

      const result = previewEmergencyRedeem(
        shares,
        totalAssets,
        totalShares,
        decimalsOffset,
        defaultConfig,
      );

      // Gross assets should be approximately 1M (1:1 ratio)
      expect(result.grossAssets.gt(new BN(0))).to.be.true;
      // Penalty = 5% of gross
      expect(result.penalty.gt(new BN(0))).to.be.true;
      // Net = gross - penalty
      expect(result.netAssets.eq(result.grossAssets.sub(result.penalty))).to.be
        .true;
      expect(result.sharesBurned.eq(shares)).to.be.true;
    });

    it("handles zero shares", () => {
      const result = previewEmergencyRedeem(
        new BN(0),
        ONE_MILLION,
        ONE_MILLION,
        3,
        defaultConfig,
      );

      expect(result.grossAssets.toNumber()).to.equal(0);
      expect(result.penalty.toNumber()).to.equal(0);
      expect(result.netAssets.toNumber()).to.equal(0);
    });

    it("handles small redemption triggering min penalty", () => {
      const shares = new BN(1_000_000_000); // Small shares
      const result = previewEmergencyRedeem(
        shares,
        ONE_MILLION,
        new BN(1_000_000_000_000_000),
        3,
        defaultConfig,
      );

      // Small redemption might trigger min penalty
      expect(result.penalty.gte(defaultConfig.minPenalty)).to.be.true;
    });
  });

  describe("previewEmergencyWithdraw", () => {
    it("calculates shares needed for desired net assets", () => {
      const assetsWanted = new BN(100_000_000_000); // 100K USDC
      const totalAssets = ONE_MILLION;
      const totalShares = new BN(1_000_000_000_000_000);
      const decimalsOffset = 3;

      const result = previewEmergencyWithdraw(
        assetsWanted,
        totalAssets,
        totalShares,
        decimalsOffset,
        defaultConfig,
      );

      // Gross should be higher than wanted (to account for penalty)
      expect(result.grossAssets.gt(assetsWanted)).to.be.true;
      // Net should be approximately what was wanted
      expect(result.netAssets.gte(assetsWanted)).to.be.true;
      expect(result.sharesBurned.gt(new BN(0))).to.be.true;
    });

    it("handles zero assets wanted", () => {
      const result = previewEmergencyWithdraw(
        new BN(0),
        ONE_MILLION,
        ONE_MILLION,
        3,
        defaultConfig,
      );

      expect(result.grossAssets.toNumber()).to.equal(0);
      expect(result.sharesBurned.toNumber()).to.equal(0);
    });

    it("handles 100% penalty rate", () => {
      const config = createEmergencyConfig(10000, PENALTY_RECIPIENT);

      const result = previewEmergencyWithdraw(
        HUNDRED_K,
        ONE_MILLION,
        ONE_MILLION,
        3,
        config,
      );

      // With 100% penalty, nothing can be withdrawn
      expect(result.netAssets.toNumber()).to.equal(0);
    });
  });

  describe("canEmergencyWithdraw", () => {
    it("denies when vault not paused", () => {
      const result = canEmergencyWithdraw(
        false, // not paused
        0,
        1000,
        3600,
      );

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(EmergencyDenialReason.VaultNotPaused);
    });

    it("allows when vault paused and cooldown passed", () => {
      const result = canEmergencyWithdraw(
        true, // paused
        0, // last withdraw at 0
        4000, // current time (4000 > cooldown 3600)
        3600, // 1 hour cooldown
      );

      expect(result.allowed).to.be.true;
      expect(result.waitTime).to.equal(0);
    });

    it("denies when cooldown active", () => {
      const result = canEmergencyWithdraw(
        true, // paused
        1000, // last withdraw at 1000
        2000, // current time (only 1000 seconds passed)
        3600, // 1 hour cooldown
      );

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(EmergencyDenialReason.CooldownActive);
      expect(result.waitTime).to.equal(2600); // 3600 - 1000 = 2600 remaining
    });

    it("allows with zero cooldown", () => {
      const result = canEmergencyWithdraw(
        true,
        1000, // last withdraw
        1001, // just 1 second later
        0, // no cooldown
      );

      expect(result.allowed).to.be.true;
    });

    it("allows first-time withdrawal (never withdrawn before)", () => {
      const result = canEmergencyWithdraw(
        true,
        0, // never withdrawn
        100,
        3600,
      );

      expect(result.allowed).to.be.true;
    });
  });

  describe("getEmergencyStatus", () => {
    it("returns correct status when emergency enabled", () => {
      const status = getEmergencyStatus(
        true, // paused
        new BN(1_000_000_000_000_000), // user shares
        ONE_MILLION,
        new BN(1_000_000_000_000_000),
        3,
        0, // last withdraw
        1000, // current time
        defaultConfig,
      );

      expect(status.isEmergencyEnabled).to.be.true;
      expect(status.userCooldownRemaining).to.equal(2600); // 3600 - 1000
      expect(status.estimatedPenalty.gt(new BN(0))).to.be.true;
    });

    it("returns disabled when vault not paused", () => {
      const status = getEmergencyStatus(
        false, // not paused
        new BN(1_000_000_000_000_000),
        ONE_MILLION,
        new BN(1_000_000_000_000_000),
        3,
        0,
        10000,
        defaultConfig,
      );

      expect(status.isEmergencyEnabled).to.be.false;
    });

    it("returns zero cooldown when cooldown passed", () => {
      const status = getEmergencyStatus(
        true,
        new BN(1_000_000_000_000_000),
        ONE_MILLION,
        new BN(1_000_000_000_000_000),
        3,
        0, // last withdraw at 0
        5000, // 5000 > 3600 cooldown
        defaultConfig,
      );

      expect(status.userCooldownRemaining).to.equal(0);
    });
  });

  describe("validateEmergencyConfig", () => {
    it("validates correct config", () => {
      expect(validateEmergencyConfig(defaultConfig)).to.be.true;
    });

    it("rejects negative penalty rate", () => {
      const config: EmergencyConfig = {
        ...defaultConfig,
        penaltyBps: -1,
      };
      expect(validateEmergencyConfig(config)).to.be.false;
    });

    it("rejects penalty rate > 100%", () => {
      const config: EmergencyConfig = {
        ...defaultConfig,
        penaltyBps: 10001,
      };
      expect(validateEmergencyConfig(config)).to.be.false;
    });

    it("rejects negative min penalty", () => {
      const config: EmergencyConfig = {
        ...defaultConfig,
        minPenalty: new BN(-1),
      };
      expect(validateEmergencyConfig(config)).to.be.false;
    });

    it("rejects max penalty < min penalty", () => {
      const config: EmergencyConfig = {
        ...defaultConfig,
        minPenalty: new BN(1000),
        maxPenalty: new BN(100),
      };
      expect(validateEmergencyConfig(config)).to.be.false;
    });

    it("rejects negative cooldown", () => {
      const config: EmergencyConfig = {
        ...defaultConfig,
        cooldownPeriod: -1,
      };
      expect(validateEmergencyConfig(config)).to.be.false;
    });

    it("accepts 100% penalty rate", () => {
      const config = createEmergencyConfig(10000, PENALTY_RECIPIENT);
      expect(validateEmergencyConfig(config)).to.be.true;
    });

    it("accepts zero penalty rate", () => {
      const config = createEmergencyConfig(0, PENALTY_RECIPIENT);
      expect(validateEmergencyConfig(config)).to.be.true;
    });
  });

  describe("Edge Cases", () => {
    it("penalty exactly equals assets", () => {
      const config = createEmergencyConfig(10000, PENALTY_RECIPIENT); // 100%
      const assets = new BN(1000);

      const penalty = calculateEmergencyPenalty(assets, config);

      expect(penalty.eq(assets)).to.be.true;
    });

    it("handles very small amounts", () => {
      const result = previewEmergencyRedeem(
        new BN(1), // 1 share
        new BN(1000),
        new BN(1000),
        3,
        defaultConfig,
      );

      // Should not crash and return valid result
      expect(result.grossAssets.gte(new BN(0))).to.be.true;
    });

    it("handles large amounts without overflow", () => {
      const largeShares = new BN("18446744073709551615"); // u64 max
      const largeAssets = new BN("18446744073709551615");

      const result = previewEmergencyRedeem(
        largeShares,
        largeAssets,
        largeShares,
        0,
        defaultConfig,
      );

      // Should not overflow
      expect(result.penalty.lte(result.grossAssets)).to.be.true;
      expect(result.netAssets.gte(new BN(0))).to.be.true;
    });
  });
});
