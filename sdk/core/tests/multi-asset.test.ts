/** Tests for multi-asset portfolios: weight validation, rebalancing, allocation */

import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  VaultAllocation,
  validateWeights,
  allocateDeposit,
  calculateCurrentWeights,
  needsRebalance,
  calculateRebalanceOps,
  allocateRedemption,
  getMultiVaultState,
  createMultiVaultConfig,
  validateMultiVaultConfig,
  calculatePortfolioShare,
} from "../src/multi-asset";

describe("SDK Multi-Asset Module", () => {
  const VAULT_1 = Keypair.generate().publicKey;
  const VAULT_2 = Keypair.generate().publicKey;
  const VAULT_3 = Keypair.generate().publicKey;
  const VAULT_4 = Keypair.generate().publicKey;

  const ONE_MILLION = new BN(1_000_000_000_000);
  const HUNDRED_K = new BN(100_000_000_000);

  describe("validateWeights", () => {
    it("validates weights summing to 100%", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      expect(validateWeights(allocations)).to.be.true;
    });

    it("rejects weights not summing to 100%", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 4000 },
      ];

      expect(validateWeights(allocations)).to.be.false;
    });

    it("validates three vault allocation", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 3000 },
        { vault: VAULT_3, targetWeight: 2000 },
      ];

      expect(validateWeights(allocations)).to.be.true;
    });

    it("rejects empty allocations", () => {
      expect(validateWeights([])).to.be.false;
    });

    it("validates single 100% allocation", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 10000 },
      ];

      expect(validateWeights(allocations)).to.be.true;
    });
  });

  describe("allocateDeposit", () => {
    it("allocates 50/50 correctly", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const result = allocateDeposit(ONE_MILLION, allocations);

      expect(result.get(VAULT_1.toBase58())?.toNumber()).to.equal(
        500_000_000_000,
      );
      expect(result.get(VAULT_2.toBase58())?.toNumber()).to.equal(
        500_000_000_000,
      );
    });

    it("allocates 70/30 correctly", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 7000 },
        { vault: VAULT_2, targetWeight: 3000 },
      ];

      const result = allocateDeposit(ONE_MILLION, allocations);

      expect(result.get(VAULT_1.toBase58())?.toNumber()).to.equal(
        700_000_000_000,
      );
      expect(result.get(VAULT_2.toBase58())?.toNumber()).to.equal(
        300_000_000_000,
      );
    });

    it("handles three-way allocation", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 3000 },
        { vault: VAULT_3, targetWeight: 2000 },
      ];

      const result = allocateDeposit(ONE_MILLION, allocations);

      const v1 = result.get(VAULT_1.toBase58())!;
      const v2 = result.get(VAULT_2.toBase58())!;
      const v3 = result.get(VAULT_3.toBase58())!;

      // Sum should equal total (last gets remainder)
      expect(v1.add(v2).add(v3).toNumber()).to.equal(ONE_MILLION.toNumber());
    });

    it("handles zero deposit", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const result = allocateDeposit(new BN(0), allocations);

      expect(result.size).to.equal(0);
    });

    it("handles rounding correctly (remainder to last)", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 3333 },
        { vault: VAULT_2, targetWeight: 3333 },
        { vault: VAULT_3, targetWeight: 3334 },
      ];

      const result = allocateDeposit(new BN(100), allocations);

      const total = result
        .get(VAULT_1.toBase58())!
        .add(result.get(VAULT_2.toBase58())!)
        .add(result.get(VAULT_3.toBase58())!);

      expect(total.toNumber()).to.equal(100);
    });
  });

  describe("calculateCurrentWeights", () => {
    it("calculates equal weights correctly", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(500));
      values.set(VAULT_2.toBase58(), new BN(500));

      const result = calculateCurrentWeights(allocations, values);

      expect(result[0].currentWeight).to.equal(5000);
      expect(result[1].currentWeight).to.equal(5000);
    });

    it("calculates unequal weights correctly", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(700));
      values.set(VAULT_2.toBase58(), new BN(300));

      const result = calculateCurrentWeights(allocations, values);

      expect(result[0].currentWeight).to.equal(7000);
      expect(result[1].currentWeight).to.equal(3000);
    });

    it("handles zero total value", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(0));
      values.set(VAULT_2.toBase58(), new BN(0));

      const result = calculateCurrentWeights(allocations, values);

      expect(result[0].currentWeight).to.equal(0);
      expect(result[1].currentWeight).to.equal(0);
    });

    it("handles missing vault value", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(1000));
      // VAULT_2 not set

      const result = calculateCurrentWeights(allocations, values);

      expect(result[0].currentWeight).to.equal(10000); // 100%
      expect(result[1].currentWeight).to.equal(0);
    });
  });

  describe("needsRebalance", () => {
    it("returns false when within threshold", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000, currentWeight: 5200 },
        { vault: VAULT_2, targetWeight: 5000, currentWeight: 4800 },
      ];

      expect(needsRebalance(allocations, 500)).to.be.false;
    });

    it("returns true when exceeding threshold", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000, currentWeight: 6000 },
        { vault: VAULT_2, targetWeight: 5000, currentWeight: 4000 },
      ];

      expect(needsRebalance(allocations, 500)).to.be.true;
    });

    it("returns false when exactly at threshold", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000, currentWeight: 5500 },
        { vault: VAULT_2, targetWeight: 5000, currentWeight: 4500 },
      ];

      expect(needsRebalance(allocations, 500)).to.be.false;
    });

    it("ignores allocations without current weight", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 }, // No currentWeight
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      expect(needsRebalance(allocations, 500)).to.be.false;
    });
  });

  describe("calculateRebalanceOps", () => {
    it("generates correct rebalance operation", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(700)); // 70%, should be 50%
      values.set(VAULT_2.toBase58(), new BN(300)); // 30%, should be 50%

      const ops = calculateRebalanceOps(allocations, values);

      expect(ops.length).to.equal(1);
      expect(ops[0].fromVault.equals(VAULT_1)).to.be.true;
      expect(ops[0].toVault.equals(VAULT_2)).to.be.true;
      expect(ops[0].amount.toNumber()).to.equal(200); // Move 200 from V1 to V2
    });

    it("generates multiple operations for complex rebalance", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 2500 },
        { vault: VAULT_2, targetWeight: 2500 },
        { vault: VAULT_3, targetWeight: 2500 },
        { vault: VAULT_4, targetWeight: 2500 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(400)); // 40%, should be 25%
      values.set(VAULT_2.toBase58(), new BN(400)); // 40%, should be 25%
      values.set(VAULT_3.toBase58(), new BN(100)); // 10%, should be 25%
      values.set(VAULT_4.toBase58(), new BN(100)); // 10%, should be 25%

      const ops = calculateRebalanceOps(allocations, values);

      // Should have operations to move from V1/V2 to V3/V4
      expect(ops.length).to.be.greaterThan(0);

      // Total amount moved should balance the portfolio
      let totalMoved = new BN(0);
      for (const op of ops) {
        totalMoved = totalMoved.add(op.amount);
      }
      expect(totalMoved.toNumber()).to.be.greaterThan(0);
    });

    it("returns empty ops when already balanced", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(500));
      values.set(VAULT_2.toBase58(), new BN(500));

      const ops = calculateRebalanceOps(allocations, values);

      expect(ops.length).to.equal(0);
    });

    it("handles zero total value", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();

      const ops = calculateRebalanceOps(allocations, values);

      expect(ops.length).to.equal(0);
    });
  });

  describe("allocateRedemption", () => {
    it("allocates proportionally to current values", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(700));
      values.set(VAULT_2.toBase58(), new BN(300));

      const result = allocateRedemption(new BN(100), allocations, values);

      expect(result.get(VAULT_1.toBase58())?.toNumber()).to.equal(70);
      expect(result.get(VAULT_2.toBase58())?.toNumber()).to.equal(30);
    });

    it("handles empty vault", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(1000));
      values.set(VAULT_2.toBase58(), new BN(0));

      const result = allocateRedemption(new BN(100), allocations, values);

      expect(result.get(VAULT_1.toBase58())?.toNumber()).to.equal(100);
      expect(result.get(VAULT_2.toBase58())?.toNumber()).to.equal(0);
    });

    it("handles zero redemption", () => {
      const allocations: VaultAllocation[] = [
        { vault: VAULT_1, targetWeight: 5000 },
        { vault: VAULT_2, targetWeight: 5000 },
      ];

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(500));
      values.set(VAULT_2.toBase58(), new BN(500));

      const result = allocateRedemption(new BN(0), allocations, values);

      expect(result.size).to.equal(0);
    });
  });

  describe("getMultiVaultState", () => {
    it("returns complete state", () => {
      const config = createMultiVaultConfig([
        { vault: VAULT_1, weight: 5000 },
        { vault: VAULT_2, weight: 5000 },
      ]);

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(500));
      values.set(VAULT_2.toBase58(), new BN(500));

      const state = getMultiVaultState(config, values);

      expect(state.totalValue.toNumber()).to.equal(1000);
      expect(state.allocations.length).to.equal(2);
      expect(state.needsRebalance).to.be.false;
    });

    it("detects need for rebalance", () => {
      const config = createMultiVaultConfig(
        [
          { vault: VAULT_1, weight: 5000 },
          { vault: VAULT_2, weight: 5000 },
        ],
        { rebalanceThresholdBps: 500 },
      );

      const values = new Map<string, BN>();
      values.set(VAULT_1.toBase58(), new BN(700));
      values.set(VAULT_2.toBase58(), new BN(300));

      const state = getMultiVaultState(config, values);

      expect(state.needsRebalance).to.be.true;
      expect(state.rebalanceOperations.length).to.be.greaterThan(0);
    });
  });

  describe("validateMultiVaultConfig", () => {
    it("validates correct config", () => {
      const config = createMultiVaultConfig([
        { vault: VAULT_1, weight: 5000 },
        { vault: VAULT_2, weight: 5000 },
      ]);

      expect(validateMultiVaultConfig(config)).to.be.true;
    });

    it("rejects empty config", () => {
      const config = createMultiVaultConfig([]);
      expect(validateMultiVaultConfig(config)).to.be.false;
    });

    it("rejects invalid weight sum", () => {
      const config = {
        allocations: [
          { vault: VAULT_1, targetWeight: 5000 },
          { vault: VAULT_2, targetWeight: 4000 },
        ],
        rebalanceThresholdBps: 500,
        maxSlippageBps: 100,
      };

      expect(validateMultiVaultConfig(config)).to.be.false;
    });

    it("rejects duplicate vaults", () => {
      const config = {
        allocations: [
          { vault: VAULT_1, targetWeight: 5000 },
          { vault: VAULT_1, targetWeight: 5000 }, // Duplicate
        ],
        rebalanceThresholdBps: 500,
        maxSlippageBps: 100,
      };

      expect(validateMultiVaultConfig(config)).to.be.false;
    });

    it("rejects negative weights", () => {
      const config = {
        allocations: [
          { vault: VAULT_1, targetWeight: -1000 },
          { vault: VAULT_2, targetWeight: 11000 },
        ],
        rebalanceThresholdBps: 500,
        maxSlippageBps: 100,
      };

      expect(validateMultiVaultConfig(config)).to.be.false;
    });
  });

  describe("calculatePortfolioShare", () => {
    it("calculates correct share", () => {
      const metaShares = new BN(100);
      const totalMetaShares = new BN(1000);
      const portfolioValue = new BN(10000);

      const share = calculatePortfolioShare(
        metaShares,
        totalMetaShares,
        portfolioValue,
      );

      expect(share.toNumber()).to.equal(1000); // 10% of 10000
    });

    it("handles zero total shares", () => {
      const share = calculatePortfolioShare(
        new BN(100),
        new BN(0),
        new BN(10000),
      );

      expect(share.toNumber()).to.equal(0);
    });
  });
});
