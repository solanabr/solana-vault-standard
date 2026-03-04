/** Tests for deposit cap management: global/per-user limits, validation */

import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  CapConfig,
  CapViolation,
  checkDepositCap,
  maxDeposit,
  getCapStatus,
  validateCapConfig,
  createCapConfig,
  createDisabledCapConfig,
  createUserPosition,
} from "../src/cap";

describe("SDK Cap Module", () => {
  const USER_1 = Keypair.generate().publicKey;
  const USER_2 = Keypair.generate().publicKey;

  const ONE_MILLION = new BN(1_000_000_000_000); // 1M USDC
  const HUNDRED_K = new BN(100_000_000_000); // 100K USDC

  describe("checkDepositCap", () => {
    it("allows deposit when caps disabled", () => {
      const config = createDisabledCapConfig();
      const result = checkDepositCap(
        ONE_MILLION,
        ONE_MILLION,
        HUNDRED_K,
        config,
      );

      expect(result.allowed).to.be.true;
      expect(result.reason).to.be.undefined;
    });

    it("allows deposit within global cap", () => {
      const config = createCapConfig(ONE_MILLION, null);
      const result = checkDepositCap(
        HUNDRED_K, // deposit
        new BN(500_000_000_000), // current total: 500K
        new BN(0), // user deposit
        config,
      );

      expect(result.allowed).to.be.true;
      expect(result.maxAllowedDeposit.toNumber()).to.equal(500_000_000_000);
    });

    it("rejects deposit exceeding global cap", () => {
      const config = createCapConfig(ONE_MILLION, null);
      const result = checkDepositCap(
        new BN(600_000_000_000), // deposit 600K
        new BN(500_000_000_000), // current total: 500K, only 500K remaining
        new BN(0),
        config,
      );

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(CapViolation.GlobalCapExceeded);
      expect(result.maxAllowedDeposit.toNumber()).to.equal(500_000_000_000);
    });

    it("allows deposit within per-user cap", () => {
      const config = createCapConfig(null, HUNDRED_K);
      const result = checkDepositCap(
        new BN(50_000_000_000), // deposit 50K
        ONE_MILLION,
        new BN(30_000_000_000), // user has 30K, can add 70K more
        config,
      );

      expect(result.allowed).to.be.true;
      expect(result.maxAllowedDeposit.toNumber()).to.equal(70_000_000_000);
    });

    it("rejects deposit exceeding per-user cap", () => {
      const config = createCapConfig(null, HUNDRED_K);
      const result = checkDepositCap(
        new BN(80_000_000_000), // deposit 80K
        ONE_MILLION,
        new BN(30_000_000_000), // user has 30K, can only add 70K
        config,
      );

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(CapViolation.UserCapExceeded);
    });

    it("enforces both caps simultaneously (global limiting)", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);
      const result = checkDepositCap(
        new BN(50_000_000_000), // deposit 50K
        new BN(980_000_000_000), // current total: 980K (only 20K global remaining)
        new BN(0), // user has nothing
        config,
      );

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(CapViolation.GlobalCapExceeded);
      expect(result.maxAllowedDeposit.toNumber()).to.equal(20_000_000_000);
    });

    it("enforces both caps simultaneously (user limiting)", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);
      const result = checkDepositCap(
        new BN(50_000_000_000), // deposit 50K
        new BN(100_000_000_000), // current total: 100K (900K global remaining)
        new BN(70_000_000_000), // user has 70K (only 30K user remaining)
        config,
      );

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(CapViolation.UserCapExceeded);
      expect(result.maxAllowedDeposit.toNumber()).to.equal(30_000_000_000);
    });

    it("allows deposit exactly at cap", () => {
      const config = createCapConfig(ONE_MILLION, null);
      const result = checkDepositCap(
        new BN(500_000_000_000), // deposit 500K
        new BN(500_000_000_000), // current total: 500K (exactly 500K remaining)
        new BN(0),
        config,
      );

      expect(result.allowed).to.be.true;
    });

    it("handles zero deposit amount", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);
      const result = checkDepositCap(
        new BN(0),
        new BN(500_000_000_000),
        new BN(50_000_000_000),
        config,
      );

      expect(result.allowed).to.be.true;
    });

    it("handles vault at capacity", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);
      const result = checkDepositCap(
        new BN(1), // try to deposit 1
        ONE_MILLION, // vault at capacity
        new BN(0),
        config,
      );

      expect(result.allowed).to.be.false;
      expect(result.maxAllowedDeposit.toNumber()).to.equal(0);
    });
  });

  describe("maxDeposit", () => {
    it("returns u64 max when caps disabled", () => {
      const config = createDisabledCapConfig();
      const max = maxDeposit(ONE_MILLION, HUNDRED_K, config);

      expect(max.toString()).to.equal("18446744073709551615");
    });

    it("returns global remaining when only global cap set", () => {
      const config = createCapConfig(ONE_MILLION, null);
      const max = maxDeposit(new BN(400_000_000_000), new BN(0), config);

      expect(max.toNumber()).to.equal(600_000_000_000);
    });

    it("returns user remaining when only user cap set", () => {
      const config = createCapConfig(null, HUNDRED_K);
      const max = maxDeposit(ONE_MILLION, new BN(30_000_000_000), config);

      expect(max.toNumber()).to.equal(70_000_000_000);
    });

    it("returns minimum of both caps", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);

      // Case 1: Global is limiting
      const max1 = maxDeposit(new BN(950_000_000_000), new BN(0), config);
      expect(max1.toNumber()).to.equal(50_000_000_000);

      // Case 2: User is limiting
      const max2 = maxDeposit(
        new BN(100_000_000_000),
        new BN(80_000_000_000),
        config,
      );
      expect(max2.toNumber()).to.equal(20_000_000_000);
    });

    it("returns zero when at capacity", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);
      const max = maxDeposit(ONE_MILLION, new BN(0), config);

      expect(max.toNumber()).to.equal(0);
    });
  });

  describe("getCapStatus", () => {
    it("returns 0% utilization when caps disabled", () => {
      const config = createDisabledCapConfig();
      const status = getCapStatus(ONE_MILLION, HUNDRED_K, config);

      expect(status.globalUtilization).to.equal(0);
      expect(status.userUtilization).to.equal(0);
    });

    it("calculates correct global utilization", () => {
      const config = createCapConfig(ONE_MILLION, null);
      const status = getCapStatus(new BN(250_000_000_000), new BN(0), config);

      expect(status.globalUtilization).to.be.approximately(25, 0.1);
      expect(status.globalRemaining.toNumber()).to.equal(750_000_000_000);
    });

    it("calculates correct user utilization", () => {
      const config = createCapConfig(null, HUNDRED_K);
      const status = getCapStatus(ONE_MILLION, new BN(75_000_000_000), config);

      expect(status.userUtilization).to.be.approximately(75, 0.1);
      expect(status.userRemaining.toNumber()).to.equal(25_000_000_000);
    });

    it("caps utilization at 100%", () => {
      const config = createCapConfig(HUNDRED_K, null);
      const status = getCapStatus(new BN(150_000_000_000), new BN(0), config);

      expect(status.globalUtilization).to.equal(100);
      expect(status.globalRemaining.toNumber()).to.equal(0);
    });

    it("handles both caps simultaneously", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);
      const status = getCapStatus(
        new BN(500_000_000_000),
        new BN(40_000_000_000),
        config,
      );

      expect(status.globalUtilization).to.be.approximately(50, 0.1);
      expect(status.userUtilization).to.be.approximately(40, 0.1);
    });
  });

  describe("validateCapConfig", () => {
    it("validates correct config", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);
      expect(validateCapConfig(config)).to.be.true;
    });

    it("validates disabled config", () => {
      const config = createDisabledCapConfig();
      expect(validateCapConfig(config)).to.be.true;
    });

    it("validates config with only global cap", () => {
      const config = createCapConfig(ONE_MILLION, null);
      expect(validateCapConfig(config)).to.be.true;
    });

    it("validates config with only user cap", () => {
      const config = createCapConfig(null, HUNDRED_K);
      expect(validateCapConfig(config)).to.be.true;
    });

    it("rejects negative global cap", () => {
      const config: CapConfig = {
        globalCap: new BN(-1),
        perUserCap: null,
        enabled: true,
      };
      expect(validateCapConfig(config)).to.be.false;
    });

    it("rejects negative user cap", () => {
      const config: CapConfig = {
        globalCap: null,
        perUserCap: new BN(-1),
        enabled: true,
      };
      expect(validateCapConfig(config)).to.be.false;
    });

    it("rejects user cap > global cap", () => {
      const config = createCapConfig(HUNDRED_K, ONE_MILLION);
      expect(validateCapConfig(config)).to.be.false;
    });

    it("accepts user cap = global cap", () => {
      const config = createCapConfig(ONE_MILLION, ONE_MILLION);
      expect(validateCapConfig(config)).to.be.true;
    });
  });

  describe("Multiple Users Scenario", () => {
    it("tracks independent user caps", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);

      // User 1 has deposited 50K
      const user1Position = createUserPosition(
        USER_1,
        new BN(50_000_000_000),
        new BN(50_000_000_000_000),
      );

      // User 2 has deposited 30K
      const user2Position = createUserPosition(
        USER_2,
        new BN(30_000_000_000),
        new BN(30_000_000_000_000),
      );

      const totalAssets = new BN(80_000_000_000); // 80K total

      // User 1 can deposit up to 50K more (to reach 100K user cap)
      const user1Result = checkDepositCap(
        new BN(50_000_000_000),
        totalAssets,
        user1Position.depositedAssets,
        config,
      );
      expect(user1Result.allowed).to.be.true;
      expect(user1Result.maxAllowedDeposit.toNumber()).to.equal(50_000_000_000);

      // User 2 can deposit up to 70K more
      const user2Result = checkDepositCap(
        new BN(70_000_000_000),
        totalAssets,
        user2Position.depositedAssets,
        config,
      );
      expect(user2Result.allowed).to.be.true;
    });

    it("global cap limits even when user cap allows more", () => {
      const config = createCapConfig(ONE_MILLION, HUNDRED_K);
      const totalAssets = new BN(950_000_000_000); // 950K total

      // User has only 10K deposited (90K user remaining)
      // But global cap only allows 50K more
      const result = checkDepositCap(
        new BN(60_000_000_000), // try to deposit 60K
        totalAssets,
        new BN(10_000_000_000),
        config,
      );

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(CapViolation.GlobalCapExceeded);
      expect(result.maxAllowedDeposit.toNumber()).to.equal(50_000_000_000);
    });
  });

  describe("Edge Cases", () => {
    it("handles zero cap values", () => {
      const config = createCapConfig(new BN(0), new BN(0));
      const result = checkDepositCap(new BN(1), new BN(0), new BN(0), config);

      expect(result.allowed).to.be.false;
      expect(result.maxAllowedDeposit.toNumber()).to.equal(0);
    });

    it("handles very large cap values", () => {
      const largeValue = new BN("18446744073709551615"); // u64 max
      const config = createCapConfig(largeValue, largeValue);

      const result = checkDepositCap(
        ONE_MILLION,
        ONE_MILLION,
        new BN(0),
        config,
      );

      expect(result.allowed).to.be.true;
    });
  });
});
