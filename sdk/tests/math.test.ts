import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import {
  Rounding,
  convertToShares,
  convertToAssets,
  previewDeposit,
  previewMint,
  previewWithdraw,
  previewRedeem,
  calculateDecimalsOffset,
} from "../src/math";

describe("SDK Math Module", () => {
  const DECIMALS_OFFSET_6 = 3; // For 6-decimal assets (USDC)
  const DECIMALS_OFFSET_9 = 0; // For 9-decimal assets (SOL)

  describe("calculateDecimalsOffset", () => {
    it("calculates offset for 6-decimal asset", () => {
      expect(calculateDecimalsOffset(6)).to.equal(3);
    });

    it("calculates offset for 9-decimal asset", () => {
      expect(calculateDecimalsOffset(9)).to.equal(0);
    });

    it("throws for decimals > 9", () => {
      expect(() => calculateDecimalsOffset(10)).to.throw();
    });
  });

  describe("convertToShares (Empty Vault)", () => {
    it("returns 1:1000 ratio for 6-decimal asset in empty vault", () => {
      const assets = new BN(1_000_000); // 1 USDC
      const totalAssets = new BN(0);
      const totalShares = new BN(0);

      const shares = convertToShares(
        assets,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
        Rounding.Floor,
      );

      // With decimals_offset=3, virtual_offset = 10^3 = 1000
      // virtual_shares = 0 + 1000 = 1000
      // virtual_assets = 0 + 1 = 1
      // shares = 1_000_000 * 1000 / 1 = 1_000_000_000
      expect(shares.eq(new BN(1_000_000_000))).to.be.true;
    });

    it("returns 1:1 ratio for 9-decimal asset in empty vault", () => {
      const assets = new BN(1_000_000_000); // 1 SOL
      const totalAssets = new BN(0);
      const totalShares = new BN(0);

      const shares = convertToShares(
        assets,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_9,
        Rounding.Floor,
      );

      // With decimals_offset=0, virtual_offset = 10^0 = 1
      // shares = 1_000_000_000 * 1 / 1 = 1_000_000_000
      expect(shares.eq(new BN(1_000_000_000))).to.be.true;
    });
  });

  describe("convertToShares (Non-empty Vault)", () => {
    it("calculates proportional shares", () => {
      const assets = new BN(1_000_000); // 1 USDC deposit
      const totalAssets = new BN(10_000_000); // 10 USDC in vault
      const totalShares = new BN(10_000_000_000); // 10 shares (9 decimals)

      const shares = convertToShares(
        assets,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
        Rounding.Floor,
      );

      // virtual_shares = 10_000_000_000 + 1000 = 10_000_001_000
      // virtual_assets = 10_000_000 + 1 = 10_000_001
      // shares = 1_000_000 * 10_000_001_000 / 10_000_001
      // ≈ 999_999_900
      expect(shares.toNumber()).to.be.closeTo(999_999_900, 100);
    });
  });

  describe("convertToAssets (Non-empty Vault)", () => {
    it("calculates proportional assets", () => {
      const shares = new BN(1_000_000_000); // 1 share
      const totalAssets = new BN(10_000_000); // 10 USDC
      const totalShares = new BN(10_000_000_000); // 10 shares

      const assets = convertToAssets(
        shares,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
        Rounding.Floor,
      );

      // Should get ~1 USDC back (1_000_000)
      expect(assets.toNumber()).to.be.closeTo(1_000_000, 100);
    });
  });

  describe("Rounding Direction", () => {
    it("Floor rounds down", () => {
      const assets = new BN(7);
      const totalAssets = new BN(10);
      const totalShares = new BN(10);

      const shares = convertToShares(
        assets,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_9,
        Rounding.Floor,
      );

      // 7 * (10 + 1) / (10 + 1) = 7
      expect(shares.toNumber()).to.equal(7);
    });

    it("Ceiling rounds up", () => {
      const shares = new BN(7);
      const totalAssets = new BN(10);
      const totalShares = new BN(10);

      const assets = convertToAssets(
        shares,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_9,
        Rounding.Ceiling,
      );

      // 7 * (10 + 1) / (10 + 1) = 7
      expect(assets.toNumber()).to.equal(7);
    });
  });

  describe("Preview Functions", () => {
    it("previewDeposit uses Floor", () => {
      const assets = new BN(1_000_000);
      const totalAssets = new BN(10_000_000);
      const totalShares = new BN(10_000_000_000);

      const shares = previewDeposit(
        assets,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
      );

      // Should be same as convertToShares with Floor
      const expected = convertToShares(
        assets,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
        Rounding.Floor,
      );
      expect(shares.eq(expected)).to.be.true;
    });

    it("previewMint uses Ceiling", () => {
      const shares = new BN(1_000_000_000);
      const totalAssets = new BN(10_000_000);
      const totalShares = new BN(10_000_000_000);

      const assets = previewMint(
        shares,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
      );

      // Should be same as convertToAssets with Ceiling
      const expected = convertToAssets(
        shares,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
        Rounding.Ceiling,
      );
      expect(assets.eq(expected)).to.be.true;
    });

    it("previewWithdraw uses Ceiling", () => {
      const assets = new BN(1_000_000);
      const totalAssets = new BN(10_000_000);
      const totalShares = new BN(10_000_000_000);

      const shares = previewWithdraw(
        assets,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
      );

      // Should be same as convertToShares with Ceiling
      const expected = convertToShares(
        assets,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
        Rounding.Ceiling,
      );
      expect(shares.eq(expected)).to.be.true;
    });

    it("previewRedeem uses Floor", () => {
      const shares = new BN(1_000_000_000);
      const totalAssets = new BN(10_000_000);
      const totalShares = new BN(10_000_000_000);

      const assets = previewRedeem(
        shares,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
      );

      // Should be same as convertToAssets with Floor
      const expected = convertToAssets(
        shares,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
        Rounding.Floor,
      );
      expect(assets.eq(expected)).to.be.true;
    });
  });

  describe("Vault Protection", () => {
    it("deposit: user receives fewer shares (floor)", () => {
      const assets = new BN(333);
      const totalAssets = new BN(1000);
      const totalShares = new BN(1000);

      const shares = previewDeposit(
        assets,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_9,
      );
      const assetsBack = previewRedeem(
        shares,
        totalAssets.add(assets),
        totalShares.add(shares),
        DECIMALS_OFFSET_9,
      );

      // User should receive <= what they deposited (vault keeps dust)
      expect(assetsBack.lte(assets)).to.be.true;
    });

    it("mint: user pays more assets (ceiling)", () => {
      const sharesToMint = new BN(333);
      const totalAssets = new BN(1000);
      const totalShares = new BN(1000);

      const assetsRequired = previewMint(
        sharesToMint,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_9,
      );

      // Calculated share value
      const shareValue = convertToAssets(
        sharesToMint,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_9,
        Rounding.Floor,
      );

      // User should pay >= share value
      expect(assetsRequired.gte(shareValue)).to.be.true;
    });
  });

  describe("Edge Cases", () => {
    it("handles zero assets", () => {
      const shares = convertToShares(
        new BN(0),
        new BN(1000),
        new BN(1000),
        DECIMALS_OFFSET_6,
      );
      expect(shares.eq(new BN(0))).to.be.true;
    });

    it("handles zero shares", () => {
      const assets = convertToAssets(
        new BN(0),
        new BN(1000),
        new BN(1000),
        DECIMALS_OFFSET_6,
      );
      expect(assets.eq(new BN(0))).to.be.true;
    });

    it("handles large numbers without overflow", () => {
      const largeAmount = new BN("1000000000000000000"); // 10^18
      const totalAssets = new BN("1000000000000000000");
      const totalShares = new BN("1000000000000000000");

      const shares = convertToShares(
        largeAmount,
        totalAssets,
        totalShares,
        DECIMALS_OFFSET_6,
      );
      expect(shares.gt(new BN(0))).to.be.true;
    });
  });
});
