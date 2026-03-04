/** Tests for fee calculations: management, performance, entry/exit fees */

import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  FeeConfig,
  FeeState,
  calculateManagementFee,
  calculatePerformanceFee,
  calculateAccruedFees,
  applyEntryFee,
  applyExitFee,
  feeToShares,
  createInitialFeeState,
  validateFeeConfig,
} from "../src/fees";

describe("SDK Fees Module", () => {
  const FEE_RECIPIENT = Keypair.generate().publicKey;

  const defaultConfig: FeeConfig = {
    managementFeeBps: 200, // 2% annual
    performanceFeeBps: 2000, // 20%
    entryFeeBps: 0,
    exitFeeBps: 0,
    feeRecipient: FEE_RECIPIENT,
  };

  describe("calculateManagementFee", () => {
    it("calculates fee for one year", () => {
      const totalAssets = new BN(1_000_000_000_000); // 1M USDC (6 decimals)
      const feeBps = 200; // 2%
      const secondsElapsed = 31536000; // 1 year

      const fee = calculateManagementFee(totalAssets, feeBps, secondsElapsed);

      // 2% of 1M = 20,000 USDC
      expect(fee.toNumber()).to.equal(20_000_000_000);
    });

    it("calculates fee for half year", () => {
      const totalAssets = new BN(1_000_000_000_000);
      const feeBps = 200;
      const secondsElapsed = 31536000 / 2; // 6 months

      const fee = calculateManagementFee(totalAssets, feeBps, secondsElapsed);

      // 1% of 1M = 10,000 USDC
      expect(fee.toNumber()).to.equal(10_000_000_000);
    });

    it("calculates fee for one day", () => {
      const totalAssets = new BN(1_000_000_000_000);
      const feeBps = 200;
      const secondsElapsed = 86400; // 1 day

      const fee = calculateManagementFee(totalAssets, feeBps, secondsElapsed);

      // 2% / 365 days = ~54,794.52 USDC per day
      expect(fee.toNumber()).to.be.approximately(54_794_520, 1000);
    });

    it("returns zero for zero fee", () => {
      const totalAssets = new BN(1_000_000_000_000);
      const fee = calculateManagementFee(totalAssets, 0, 31536000);
      expect(fee.toNumber()).to.equal(0);
    });

    it("returns zero for zero time elapsed", () => {
      const totalAssets = new BN(1_000_000_000_000);
      const fee = calculateManagementFee(totalAssets, 200, 0);
      expect(fee.toNumber()).to.equal(0);
    });

    it("returns zero for zero assets", () => {
      const fee = calculateManagementFee(new BN(0), 200, 31536000);
      expect(fee.toNumber()).to.equal(0);
    });

    it("handles large asset amounts without overflow", () => {
      // 1 billion USDC
      const totalAssets = new BN("1000000000000000000");
      const feeBps = 200;
      const secondsElapsed = 31536000;

      const fee = calculateManagementFee(totalAssets, feeBps, secondsElapsed);

      // 2% of 1B = 20M
      expect(fee.toString()).to.equal("20000000000000000");
    });
  });

  describe("calculatePerformanceFee", () => {
    it("calculates fee when price exceeds HWM", () => {
      const currentSharePrice = new BN(1_200_000_000); // 1.2 scaled
      const highWaterMark = new BN(1_000_000_000); // 1.0 scaled
      const totalShares = new BN(1_000_000_000_000); // 1M shares (9 decimals)
      const feeBps = 2000; // 20%

      const { fee, newHighWaterMark } = calculatePerformanceFee(
        currentSharePrice,
        highWaterMark,
        totalShares,
        feeBps,
      );

      // Profit = 0.2 per share * 1M shares = 200,000 assets
      // Fee = 20% of 200,000 = 40,000
      expect(fee.toNumber()).to.equal(40_000_000_000);
      expect(newHighWaterMark.toString()).to.equal(
        currentSharePrice.toString(),
      );
    });

    it("returns zero when price below HWM", () => {
      const currentSharePrice = new BN(900_000_000); // 0.9 scaled
      const highWaterMark = new BN(1_000_000_000);
      const totalShares = new BN(1_000_000_000_000);
      const feeBps = 2000;

      const { fee, newHighWaterMark } = calculatePerformanceFee(
        currentSharePrice,
        highWaterMark,
        totalShares,
        feeBps,
      );

      expect(fee.toNumber()).to.equal(0);
      expect(newHighWaterMark.toString()).to.equal(highWaterMark.toString());
    });

    it("returns zero when price equals HWM", () => {
      const currentSharePrice = new BN(1_000_000_000);
      const highWaterMark = new BN(1_000_000_000);
      const totalShares = new BN(1_000_000_000_000);
      const feeBps = 2000;

      const { fee } = calculatePerformanceFee(
        currentSharePrice,
        highWaterMark,
        totalShares,
        feeBps,
      );

      expect(fee.toNumber()).to.equal(0);
    });

    it("returns zero for zero fee rate", () => {
      const currentSharePrice = new BN(1_200_000_000);
      const highWaterMark = new BN(1_000_000_000);
      const totalShares = new BN(1_000_000_000_000);

      const { fee } = calculatePerformanceFee(
        currentSharePrice,
        highWaterMark,
        totalShares,
        0,
      );

      expect(fee.toNumber()).to.equal(0);
    });

    it("returns zero for zero shares", () => {
      const currentSharePrice = new BN(1_200_000_000);
      const highWaterMark = new BN(1_000_000_000);

      const { fee } = calculatePerformanceFee(
        currentSharePrice,
        highWaterMark,
        new BN(0),
        2000,
      );

      expect(fee.toNumber()).to.equal(0);
    });
  });

  describe("calculateAccruedFees", () => {
    it("calculates combined management and performance fees", () => {
      const totalAssets = new BN(1_000_000_000_000); // 1M USDC
      const totalShares = new BN(800_000_000_000_000); // 800K shares (price > 1.0)
      const feeState = createInitialFeeState(0);
      const currentTimestamp = 31536000; // 1 year later

      const result = calculateAccruedFees(
        totalAssets,
        totalShares,
        defaultConfig,
        feeState,
        currentTimestamp,
      );

      // Management fee: 2% of 1M = 20,000
      expect(result.managementFee.toNumber()).to.equal(20_000_000_000);
      // Performance fee depends on share price exceeding HWM
      expect(result.performanceFee.gte(new BN(0))).to.be.true;
      expect(
        result.totalFee.eq(result.managementFee.add(result.performanceFee)),
      ).to.be.true;
      expect(result.netAssets.eq(totalAssets.sub(result.totalFee))).to.be.true;
    });

    it("handles zero elapsed time", () => {
      const totalAssets = new BN(1_000_000_000_000);
      const totalShares = new BN(1_000_000_000_000_000);
      const feeState = createInitialFeeState(1000);

      const result = calculateAccruedFees(
        totalAssets,
        totalShares,
        defaultConfig,
        feeState,
        1000, // Same timestamp
      );

      expect(result.managementFee.toNumber()).to.equal(0);
    });
  });

  describe("applyEntryFee", () => {
    it("deducts entry fee from shares", () => {
      const grossShares = new BN(1_000_000_000_000); // 1000 shares
      const entryFeeBps = 50; // 0.5%

      const result = applyEntryFee(grossShares, entryFeeBps);

      expect(result.grossShares.eq(grossShares)).to.be.true;
      expect(result.entryFee.toNumber()).to.equal(5_000_000_000); // 0.5%
      expect(result.netShares.toNumber()).to.equal(995_000_000_000);
    });

    it("returns full shares when no entry fee", () => {
      const grossShares = new BN(1_000_000_000_000);

      const result = applyEntryFee(grossShares, 0);

      expect(result.entryFee.toNumber()).to.equal(0);
      expect(result.netShares.eq(grossShares)).to.be.true;
    });

    it("handles zero shares", () => {
      const result = applyEntryFee(new BN(0), 50);

      expect(result.entryFee.toNumber()).to.equal(0);
      expect(result.netShares.toNumber()).to.equal(0);
    });
  });

  describe("applyExitFee", () => {
    it("deducts exit fee from assets", () => {
      const grossAssets = new BN(1_000_000_000); // 1000 USDC
      const exitFeeBps = 100; // 1%

      const result = applyExitFee(grossAssets, exitFeeBps);

      expect(result.grossAssets.eq(grossAssets)).to.be.true;
      expect(result.exitFee.toNumber()).to.equal(10_000_000); // 1%
      expect(result.netAssets.toNumber()).to.equal(990_000_000);
    });

    it("returns full assets when no exit fee", () => {
      const grossAssets = new BN(1_000_000_000);

      const result = applyExitFee(grossAssets, 0);

      expect(result.exitFee.toNumber()).to.equal(0);
      expect(result.netAssets.eq(grossAssets)).to.be.true;
    });

    it("handles zero assets", () => {
      const result = applyExitFee(new BN(0), 100);

      expect(result.exitFee.toNumber()).to.equal(0);
      expect(result.netAssets.toNumber()).to.equal(0);
    });
  });

  describe("feeToShares", () => {
    it("converts fee to proportional shares", () => {
      const feeAssets = new BN(10_000_000); // 10 USDC
      const totalAssets = new BN(1_000_000_000); // 1000 USDC
      const totalShares = new BN(1_000_000_000_000); // 1000 shares
      const decimalsOffset = 3; // USDC

      const shares = feeToShares(
        feeAssets,
        totalAssets,
        totalShares,
        decimalsOffset,
      );

      // 10/1000 of shares = 10 shares
      expect(shares.gt(new BN(0))).to.be.true;
    });

    it("returns zero for zero fee", () => {
      const shares = feeToShares(new BN(0), new BN(1000), new BN(1000), 3);
      expect(shares.toNumber()).to.equal(0);
    });
  });

  describe("validateFeeConfig", () => {
    it("validates correct config", () => {
      expect(validateFeeConfig(defaultConfig)).to.be.true;
    });

    it("rejects negative management fee", () => {
      const config = { ...defaultConfig, managementFeeBps: -1 };
      expect(validateFeeConfig(config)).to.be.false;
    });

    it("rejects management fee > 100%", () => {
      const config = { ...defaultConfig, managementFeeBps: 10001 };
      expect(validateFeeConfig(config)).to.be.false;
    });

    it("rejects negative performance fee", () => {
      const config = { ...defaultConfig, performanceFeeBps: -1 };
      expect(validateFeeConfig(config)).to.be.false;
    });

    it("rejects performance fee > 100%", () => {
      const config = { ...defaultConfig, performanceFeeBps: 10001 };
      expect(validateFeeConfig(config)).to.be.false;
    });

    it("accepts zero fees", () => {
      const config: FeeConfig = {
        managementFeeBps: 0,
        performanceFeeBps: 0,
        feeRecipient: FEE_RECIPIENT,
      };
      expect(validateFeeConfig(config)).to.be.true;
    });

    it("accepts 100% fees (edge case)", () => {
      const config: FeeConfig = {
        managementFeeBps: 10000,
        performanceFeeBps: 10000,
        feeRecipient: FEE_RECIPIENT,
      };
      expect(validateFeeConfig(config)).to.be.true;
    });
  });

  describe("Fee Compounding", () => {
    it("calculates fees over multiple periods correctly", () => {
      const totalAssets = new BN(1_000_000_000_000);
      const feeBps = 200;
      const oneMonth = 2628000; // ~30.4 days

      let remaining = totalAssets;
      for (let i = 0; i < 12; i++) {
        const fee = calculateManagementFee(remaining, feeBps, oneMonth);
        remaining = remaining.sub(fee);
      }

      // After 12 months of compounding, should be slightly less than 2% total
      const totalDeducted = totalAssets.sub(remaining);
      const percentDeducted =
        (totalDeducted.toNumber() / totalAssets.toNumber()) * 100;

      // Should be close to 2% but slightly less due to compounding on reduced principal
      expect(percentDeducted).to.be.approximately(2, 0.1);
    });
  });

  describe("Large Number Handling", () => {
    it("handles u64 max assets without overflow", () => {
      const maxU64 = new BN("18446744073709551615");
      const feeBps = 200;
      const oneYear = 31536000;

      const fee = calculateManagementFee(maxU64, feeBps, oneYear);

      // Should not throw and should return reasonable value
      expect(fee.gt(new BN(0))).to.be.true;
      expect(fee.lt(maxU64)).to.be.true;
    });

    it("handles large share counts in performance fee", () => {
      const currentSharePrice = new BN(1_100_000_000);
      const highWaterMark = new BN(1_000_000_000);
      const largeShares = new BN("1000000000000000000"); // 10^18

      const { fee } = calculatePerformanceFee(
        currentSharePrice,
        highWaterMark,
        largeShares,
        2000,
      );

      expect(fee.gt(new BN(0))).to.be.true;
    });
  });
});
