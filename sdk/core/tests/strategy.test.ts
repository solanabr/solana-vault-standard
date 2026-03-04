import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  StrategyType,
  StrategyStatus,
  StrategyConfig,
  StrategyPosition,
  StrategyManager,
  calculateStrategyAllocations,
  previewDeploy,
  previewRecall,
  getTotalDeployed,
  getCurrentWeights,
  strategyNeedsRebalance,
  validateStrategyConfig,
  validateTargetWeights,
  checkStrategyHealth,
  getPortfolioHealth,
  createLendingStrategy,
  createLiquidStakingStrategy,
  createLpStrategy,
  createInitialPosition,
  updatePositionAfterDeploy,
  updatePositionAfterRecall,
  syncPositionValue,
} from "../src/strategy";

describe("SDK Strategy Module", () => {
  const PROGRAM_1 = Keypair.generate().publicKey;
  const PROGRAM_2 = Keypair.generate().publicKey;
  const POOL_1 = Keypair.generate().publicKey;
  const POOL_2 = Keypair.generate().publicKey;
  const MINT_1 = Keypair.generate().publicKey;
  const MINT_2 = Keypair.generate().publicKey;

  const SCALE = new BN(1_000_000_000); // 1e9

  function createTestStrategy(
    id: string,
    maxAllocationBps: number = 5000,
    status: StrategyStatus = StrategyStatus.Active,
  ): StrategyConfig {
    return {
      id,
      type: StrategyType.Lending,
      programId: PROGRAM_1,
      name: `Test Strategy ${id}`,
      status,
      maxAllocationBps,
      expectedApyBps: 500,
      riskScore: 3,
      accounts: {
        protocolState: POOL_1,
        receiptMint: MINT_1,
        additionalAccounts: [],
      },
    };
  }

  function createTestPosition(
    strategyId: string,
    deployedAssets: BN,
    estimatedValue: BN,
    receiptTokens?: BN,
  ): StrategyPosition {
    return {
      strategyId,
      deployedAssets,
      receiptTokens: receiptTokens ?? estimatedValue,
      lastSyncTimestamp: Date.now() / 1000,
      estimatedValue,
      accumulatedRewards: new BN(0),
    };
  }

  describe("calculateStrategyAllocations", () => {
    it("allocates 100% to single strategy", () => {
      const strategies = [createTestStrategy("strat1", 10000)];
      const weights = new Map([["strat1", 10000]]);
      const totalAssets = new BN(1_000_000);

      const allocations = calculateStrategyAllocations(
        totalAssets,
        strategies,
        weights,
      );

      expect(allocations.length).to.equal(1);
      expect(allocations[0].strategyId).to.equal("strat1");
      expect(allocations[0].amount.toNumber()).to.equal(1_000_000);
    });

    it("allocates 50/50 to two strategies", () => {
      const strategies = [
        createTestStrategy("strat1", 10000),
        createTestStrategy("strat2", 10000),
      ];
      const weights = new Map([
        ["strat1", 5000],
        ["strat2", 5000],
      ]);
      const totalAssets = new BN(1_000_000);

      const allocations = calculateStrategyAllocations(
        totalAssets,
        strategies,
        weights,
      );

      expect(allocations.length).to.equal(2);
      expect(allocations[0].amount.toNumber()).to.equal(500_000);
      expect(allocations[1].amount.toNumber()).to.equal(500_000);
    });

    it("respects max allocation cap", () => {
      const strategies = [
        createTestStrategy("strat1", 3000), // Max 30%
      ];
      const weights = new Map([["strat1", 10000]]); // Target 100%
      const totalAssets = new BN(1_000_000);

      const allocations = calculateStrategyAllocations(
        totalAssets,
        strategies,
        weights,
      );

      expect(allocations.length).to.equal(1);
      // Should be capped at 30%
      expect(allocations[0].amount.toNumber()).to.equal(300_000);
    });

    it("skips inactive strategies", () => {
      const strategies = [
        createTestStrategy("strat1", 10000, StrategyStatus.Paused),
        createTestStrategy("strat2", 10000, StrategyStatus.Active),
      ];
      const weights = new Map([
        ["strat1", 5000],
        ["strat2", 5000],
      ]);
      const totalAssets = new BN(1_000_000);

      const allocations = calculateStrategyAllocations(
        totalAssets,
        strategies,
        weights,
      );

      expect(allocations.length).to.equal(1);
      expect(allocations[0].strategyId).to.equal("strat2");
    });

    it("handles zero deposit", () => {
      const strategies = [createTestStrategy("strat1", 10000)];
      const weights = new Map([["strat1", 10000]]);

      const allocations = calculateStrategyAllocations(
        new BN(0),
        strategies,
        weights,
      );

      expect(allocations.length).to.equal(0);
    });

    it("handles three-way allocation", () => {
      const strategies = [
        createTestStrategy("strat1", 10000),
        createTestStrategy("strat2", 10000),
        createTestStrategy("strat3", 10000),
      ];
      const weights = new Map([
        ["strat1", 5000],
        ["strat2", 3000],
        ["strat3", 2000],
      ]);
      const totalAssets = new BN(1_000_000);

      const allocations = calculateStrategyAllocations(
        totalAssets,
        strategies,
        weights,
      );

      expect(allocations.length).to.equal(3);
      expect(allocations[0].amount.toNumber()).to.equal(500_000);
      expect(allocations[1].amount.toNumber()).to.equal(300_000);
      expect(allocations[2].amount.toNumber()).to.equal(200_000);
    });
  });

  describe("previewDeploy", () => {
    it("calculates expected receipt tokens", () => {
      const strategy = createTestStrategy("strat1");
      const assets = new BN(1_000_000);
      const exchangeRate = SCALE; // 1:1

      const preview = previewDeploy(assets, strategy, exchangeRate);

      expect(preview.expectedReceiptTokens.toNumber()).to.equal(1_000_000);
    });

    it("calculates with different exchange rate", () => {
      const strategy = createTestStrategy("strat1");
      const assets = new BN(1_000_000);
      const exchangeRate = SCALE.muln(2); // 2:1 (receipt token worth 2x)

      const preview = previewDeploy(assets, strategy, exchangeRate);

      expect(preview.expectedReceiptTokens.toNumber()).to.equal(500_000);
    });

    it("applies slippage correctly", () => {
      const strategy = createTestStrategy("strat1");
      const assets = new BN(1_000_000);
      const exchangeRate = SCALE;
      const slippageBps = 100; // 1%

      const preview = previewDeploy(
        assets,
        strategy,
        exchangeRate,
        slippageBps,
      );

      expect(preview.minReceiptTokens.toNumber()).to.equal(990_000);
    });
  });

  describe("previewRecall", () => {
    it("calculates expected assets", () => {
      const strategy = createTestStrategy("strat1");
      const receiptTokens = new BN(1_000_000);
      const exchangeRate = SCALE; // 1:1

      const preview = previewRecall(receiptTokens, strategy, exchangeRate);

      expect(preview.expectedAssets.toNumber()).to.equal(1_000_000);
    });

    it("calculates with appreciated exchange rate", () => {
      const strategy = createTestStrategy("strat1");
      const receiptTokens = new BN(1_000_000);
      const exchangeRate = new BN(1_100_000_000); // 1.1 (10% gain)

      const preview = previewRecall(receiptTokens, strategy, exchangeRate);

      expect(preview.expectedAssets.toNumber()).to.equal(1_100_000);
    });

    it("applies slippage correctly", () => {
      const strategy = createTestStrategy("strat1");
      const receiptTokens = new BN(1_000_000);
      const exchangeRate = SCALE;
      const slippageBps = 50; // 0.5%

      const preview = previewRecall(
        receiptTokens,
        strategy,
        exchangeRate,
        slippageBps,
      );

      expect(preview.minAssets.toNumber()).to.equal(995_000);
    });
  });

  describe("getTotalDeployed", () => {
    it("sums all position values", () => {
      const positions = [
        createTestPosition("strat1", new BN(100_000), new BN(110_000)),
        createTestPosition("strat2", new BN(200_000), new BN(220_000)),
      ];

      const total = getTotalDeployed(positions);

      expect(total.toNumber()).to.equal(330_000);
    });

    it("returns zero for empty positions", () => {
      const total = getTotalDeployed([]);
      expect(total.toNumber()).to.equal(0);
    });
  });

  describe("getCurrentWeights", () => {
    it("calculates correct weights", () => {
      const positions = [
        createTestPosition("strat1", new BN(100_000), new BN(100_000)),
        createTestPosition("strat2", new BN(100_000), new BN(100_000)),
      ];

      const weights = getCurrentWeights(positions);

      expect(weights.get("strat1")).to.equal(5000);
      expect(weights.get("strat2")).to.equal(5000);
    });

    it("handles unequal positions", () => {
      const positions = [
        createTestPosition("strat1", new BN(300_000), new BN(300_000)),
        createTestPosition("strat2", new BN(100_000), new BN(100_000)),
      ];

      const weights = getCurrentWeights(positions);

      expect(weights.get("strat1")).to.equal(7500);
      expect(weights.get("strat2")).to.equal(2500);
    });

    it("handles zero total", () => {
      const positions = [createTestPosition("strat1", new BN(0), new BN(0))];

      const weights = getCurrentWeights(positions);

      expect(weights.size).to.equal(0);
    });
  });

  describe("strategyNeedsRebalance", () => {
    it("returns false when within threshold", () => {
      const positions = [
        createTestPosition("strat1", new BN(500_000), new BN(500_000)),
        createTestPosition("strat2", new BN(500_000), new BN(500_000)),
      ];
      const targetWeights = new Map([
        ["strat1", 5000],
        ["strat2", 5000],
      ]);

      expect(strategyNeedsRebalance(positions, targetWeights, 100)).to.be.false;
    });

    it("returns true when exceeding threshold", () => {
      const positions = [
        createTestPosition("strat1", new BN(600_000), new BN(600_000)),
        createTestPosition("strat2", new BN(400_000), new BN(400_000)),
      ];
      const targetWeights = new Map([
        ["strat1", 5000],
        ["strat2", 5000],
      ]);

      // 60/40 vs 50/50 = 10% drift
      expect(strategyNeedsRebalance(positions, targetWeights, 500)).to.be.true;
    });
  });

  describe("validateStrategyConfig", () => {
    it("validates correct config", () => {
      const config = createTestStrategy("strat1");
      expect(validateStrategyConfig(config)).to.be.true;
    });

    it("rejects invalid max allocation", () => {
      const config = createTestStrategy("strat1");
      config.maxAllocationBps = 15000; // > 100%

      expect(validateStrategyConfig(config)).to.be.false;
    });

    it("rejects negative max allocation", () => {
      const config = createTestStrategy("strat1");
      config.maxAllocationBps = -100;

      expect(validateStrategyConfig(config)).to.be.false;
    });

    it("rejects invalid risk score", () => {
      const config = createTestStrategy("strat1");
      config.riskScore = 15; // > 10

      expect(validateStrategyConfig(config)).to.be.false;
    });

    it("rejects zero risk score", () => {
      const config = createTestStrategy("strat1");
      config.riskScore = 0;

      expect(validateStrategyConfig(config)).to.be.false;
    });
  });

  describe("validateTargetWeights", () => {
    it("validates correct weights", () => {
      const strategies = [
        createTestStrategy("strat1", 10000), // Allow up to 100%
        createTestStrategy("strat2", 10000),
      ];
      const weights = new Map([
        ["strat1", 6000],
        ["strat2", 4000],
      ]);

      const result = validateTargetWeights(weights, strategies);

      expect(result.valid).to.be.true;
    });

    it("rejects weights not summing to 10000", () => {
      const strategies = [
        createTestStrategy("strat1"),
        createTestStrategy("strat2"),
      ];
      const weights = new Map([
        ["strat1", 5000],
        ["strat2", 3000],
      ]);

      const result = validateTargetWeights(weights, strategies);

      expect(result.valid).to.be.false;
      expect(result.error).to.include("8000");
    });

    it("rejects negative weight", () => {
      const strategies = [createTestStrategy("strat1")];
      const weights = new Map([["strat1", -100]]);

      const result = validateTargetWeights(weights, strategies);

      expect(result.valid).to.be.false;
      expect(result.error).to.include("Negative");
    });

    it("rejects unknown strategy", () => {
      const strategies = [createTestStrategy("strat1")];
      const weights = new Map([["unknown", 10000]]);

      const result = validateTargetWeights(weights, strategies);

      expect(result.valid).to.be.false;
      expect(result.error).to.include("Unknown");
    });

    it("rejects weight exceeding max allocation", () => {
      const strategies = [createTestStrategy("strat1", 5000)]; // Max 50%
      const weights = new Map([["strat1", 10000]]); // 100%

      const result = validateTargetWeights(weights, strategies);

      expect(result.valid).to.be.false;
      expect(result.error).to.include("exceeds max");
    });

    it("rejects inactive strategy", () => {
      const strategies = [
        createTestStrategy("strat1", 10000, StrategyStatus.Paused),
      ];
      const weights = new Map([["strat1", 10000]]);

      const result = validateTargetWeights(weights, strategies);

      expect(result.valid).to.be.false;
      expect(result.error).to.include("not active");
    });
  });

  describe("checkStrategyHealth", () => {
    it("returns healthy for normal position", () => {
      const strategy = createTestStrategy("strat1");
      const position = createTestPosition(
        "strat1",
        new BN(100_000),
        new BN(105_000),
      );
      position.lastSyncTimestamp = Date.now() / 1000;

      const result = checkStrategyHealth(
        position,
        strategy,
        SCALE.muln(105).divn(100), // 1.05
        SCALE, // 1.0
        Date.now() / 1000,
      );

      expect(result.healthy).to.be.true;
      expect(result.healthScore).to.be.greaterThan(70);
    });

    it("detects value loss", () => {
      const strategy = createTestStrategy("strat1");
      const position = createTestPosition(
        "strat1",
        new BN(100_000),
        new BN(90_000),
      );
      position.lastSyncTimestamp = Date.now() / 1000;

      const result = checkStrategyHealth(
        position,
        strategy,
        SCALE.muln(90).divn(100), // 0.90 (10% loss)
        SCALE, // 1.0
        Date.now() / 1000,
      );

      expect(result.issues.some((i) => i.code === "VALUE_LOSS")).to.be.true;
      expect(result.healthScore).to.be.lessThan(100);
    });

    it("detects stale data", () => {
      const strategy = createTestStrategy("strat1");
      const position = createTestPosition(
        "strat1",
        new BN(100_000),
        new BN(100_000),
      );
      position.lastSyncTimestamp = Date.now() / 1000 - 86400 * 2; // 2 days ago

      const result = checkStrategyHealth(
        position,
        strategy,
        SCALE,
        SCALE,
        Date.now() / 1000,
      );

      expect(result.issues.some((i) => i.code === "STALE_DATA")).to.be.true;
    });

    it("detects inactive strategy", () => {
      const strategy = createTestStrategy(
        "strat1",
        5000,
        StrategyStatus.Deprecated,
      );
      const position = createTestPosition(
        "strat1",
        new BN(100_000),
        new BN(100_000),
      );
      position.lastSyncTimestamp = Date.now() / 1000;

      const result = checkStrategyHealth(
        position,
        strategy,
        SCALE,
        SCALE,
        Date.now() / 1000,
      );

      expect(result.issues.some((i) => i.code === "STRATEGY_NOT_ACTIVE")).to.be
        .true;
      expect(result.recommendations.length).to.be.greaterThan(0);
    });
  });

  describe("getPortfolioHealth", () => {
    it("returns healthy for all healthy strategies", () => {
      const healthChecks = [
        {
          strategyId: "strat1",
          healthy: true,
          healthScore: 90,
          issues: [],
          recommendations: [],
        },
        {
          strategyId: "strat2",
          healthy: true,
          healthScore: 85,
          issues: [],
          recommendations: [],
        },
      ];

      const result = getPortfolioHealth(healthChecks);

      expect(result.overallHealthy).to.be.true;
      expect(result.averageScore).to.equal(87.5);
      expect(result.criticalIssues).to.equal(0);
    });

    it("detects critical issues", () => {
      const healthChecks = [
        {
          strategyId: "strat1",
          healthy: false,
          healthScore: 40,
          issues: [
            { severity: "critical" as const, code: "TEST", message: "test" },
          ],
          recommendations: [],
        },
      ];

      const result = getPortfolioHealth(healthChecks);

      expect(result.overallHealthy).to.be.false;
      expect(result.criticalIssues).to.equal(1);
    });

    it("handles empty health checks", () => {
      const result = getPortfolioHealth([]);

      expect(result.overallHealthy).to.be.true;
      expect(result.averageScore).to.equal(100);
    });
  });

  describe("StrategyManager", () => {
    it("adds and retrieves strategies", () => {
      const manager = new StrategyManager();
      const strategy = createTestStrategy("strat1");

      manager.addStrategy(strategy);
      const retrieved = manager.getStrategy("strat1");

      expect(retrieved).to.not.be.null;
      expect(retrieved!.id).to.equal("strat1");
    });

    it("rejects invalid strategy", () => {
      const manager = new StrategyManager();
      const strategy = createTestStrategy("strat1");
      strategy.riskScore = 15; // Invalid

      expect(() => manager.addStrategy(strategy)).to.throw();
    });

    it("sets and validates target weights", () => {
      const manager = new StrategyManager([
        createTestStrategy("strat1", 10000),
        createTestStrategy("strat2", 10000),
      ]);
      const weights = new Map([
        ["strat1", 6000],
        ["strat2", 4000],
      ]);

      const result = manager.setTargetWeights(weights);

      expect(result.success).to.be.true;
      expect(manager.getTargetWeights().get("strat1")).to.equal(6000);
    });

    it("rejects invalid target weights", () => {
      const manager = new StrategyManager([createTestStrategy("strat1")]);
      const weights = new Map([["strat1", 5000]]); // Doesn't sum to 10000

      const result = manager.setTargetWeights(weights);

      expect(result.success).to.be.false;
    });

    it("updates strategy status", () => {
      const manager = new StrategyManager([createTestStrategy("strat1")]);

      manager.updateStrategyStatus("strat1", StrategyStatus.Paused);

      expect(manager.getStrategy("strat1")!.status).to.equal(
        StrategyStatus.Paused,
      );
    });

    it("calculates allocations", () => {
      const manager = new StrategyManager([
        createTestStrategy("strat1", 10000),
        createTestStrategy("strat2", 10000),
      ]);
      manager.setTargetWeights(
        new Map([
          ["strat1", 7000],
          ["strat2", 3000],
        ]),
      );

      const allocations = manager.calculateAllocations(new BN(1_000_000));

      expect(allocations.length).to.equal(2);
      expect(allocations[0].amount.toNumber()).to.equal(700_000);
      expect(allocations[1].amount.toNumber()).to.equal(300_000);
    });

    it("tracks positions", () => {
      const manager = new StrategyManager([createTestStrategy("strat1")]);
      const position = createTestPosition(
        "strat1",
        new BN(100_000),
        new BN(105_000),
      );

      manager.updatePosition(position);

      expect(manager.getPosition("strat1")).to.not.be.null;
      expect(manager.getTotalDeployed().toNumber()).to.equal(105_000);
    });

    it("calculates recall amounts", () => {
      const manager = new StrategyManager([
        { ...createTestStrategy("strat1"), riskScore: 8, expectedApyBps: 1000 },
        { ...createTestStrategy("strat2"), riskScore: 3, expectedApyBps: 500 },
      ]);
      manager.updatePosition(
        createTestPosition("strat1", new BN(500_000), new BN(500_000)),
      );
      manager.updatePosition(
        createTestPosition("strat2", new BN(500_000), new BN(500_000)),
      );

      // Recall 300K (should prioritize high risk first)
      const recalls = manager.calculateRecallAmounts(new BN(700_000));

      expect(recalls.length).to.be.greaterThan(0);
      // Higher risk strategy should be recalled first
      expect(recalls[0].strategyId).to.equal("strat1");
    });

    it("removes strategy with zero position", () => {
      const manager = new StrategyManager([createTestStrategy("strat1")]);

      const removed = manager.removeStrategy("strat1");

      expect(removed).to.be.true;
      expect(manager.getStrategy("strat1")).to.be.null;
    });

    it("prevents removing strategy with active position", () => {
      const manager = new StrategyManager([createTestStrategy("strat1")]);
      manager.updatePosition(
        createTestPosition("strat1", new BN(100_000), new BN(100_000)),
      );

      const removed = manager.removeStrategy("strat1");

      expect(removed).to.be.false;
    });

    it("checks rebalance need", () => {
      const manager = new StrategyManager([
        createTestStrategy("strat1", 10000),
        createTestStrategy("strat2", 10000),
      ]);
      manager.setTargetWeights(
        new Map([
          ["strat1", 5000],
          ["strat2", 5000],
        ]),
      );
      manager.updatePosition(
        createTestPosition("strat1", new BN(700_000), new BN(700_000)),
      );
      manager.updatePosition(
        createTestPosition("strat2", new BN(300_000), new BN(300_000)),
      );

      // 70/30 vs 50/50 = 20% drift
      expect(manager.needsRebalance(500)).to.be.true; // 5% threshold
      expect(manager.needsRebalance(2500)).to.be.false; // 25% threshold
    });
  });

  describe("Strategy Templates", () => {
    it("creates lending strategy", () => {
      const strategy = createLendingStrategy(
        "solend-usdc",
        "Solend USDC",
        PROGRAM_1,
        POOL_1,
        MINT_1,
      );

      expect(strategy.type).to.equal(StrategyType.Lending);
      expect(strategy.status).to.equal(StrategyStatus.Active);
      expect(strategy.maxAllocationBps).to.equal(5000);
    });

    it("creates liquid staking strategy", () => {
      const strategy = createLiquidStakingStrategy(
        "marinade-sol",
        "Marinade SOL",
        PROGRAM_1,
        POOL_1,
        MINT_1,
        { maxAllocationBps: 9000, expectedApyBps: 800 },
      );

      expect(strategy.type).to.equal(StrategyType.LiquidStaking);
      expect(strategy.maxAllocationBps).to.equal(9000);
      expect(strategy.expectedApyBps).to.equal(800);
    });

    it("creates LP strategy", () => {
      const strategy = createLpStrategy(
        "orca-usdc-sol",
        "Orca USDC/SOL",
        PROGRAM_1,
        POOL_1,
        MINT_1,
        { riskScore: 7 },
      );

      expect(strategy.type).to.equal(StrategyType.LiquidityProvision);
      expect(strategy.riskScore).to.equal(7);
    });
  });

  describe("Position Updates", () => {
    it("creates initial position", () => {
      const position = createInitialPosition("strat1", 1000000);

      expect(position.deployedAssets.toNumber()).to.equal(0);
      expect(position.receiptTokens.toNumber()).to.equal(0);
      expect(position.lastSyncTimestamp).to.equal(1000000);
    });

    it("updates position after deploy", () => {
      const position = createInitialPosition("strat1", 1000000);
      const updated = updatePositionAfterDeploy(
        position,
        new BN(100_000),
        new BN(100_000),
        SCALE,
        1000100,
      );

      expect(updated.deployedAssets.toNumber()).to.equal(100_000);
      expect(updated.receiptTokens.toNumber()).to.equal(100_000);
      expect(updated.estimatedValue.toNumber()).to.equal(100_000);
    });

    it("updates position after recall", () => {
      const position = createTestPosition(
        "strat1",
        new BN(100_000),
        new BN(100_000),
        new BN(100_000),
      );
      const updated = updatePositionAfterRecall(
        position,
        new BN(50_000),
        new BN(55_000), // Got more due to appreciation
        SCALE.muln(110).divn(100), // 1.1
        1000200,
      );

      expect(updated.receiptTokens.toNumber()).to.equal(50_000);
      expect(updated.estimatedValue.toNumber()).to.equal(55_000);
    });

    it("syncs position value", () => {
      const position = createTestPosition(
        "strat1",
        new BN(100_000),
        new BN(100_000),
        new BN(100_000),
      );
      const updated = syncPositionValue(
        position,
        SCALE.muln(120).divn(100), // 1.2 (20% gain)
        1000300,
      );

      expect(updated.estimatedValue.toNumber()).to.equal(120_000);
      expect(updated.deployedAssets.toNumber()).to.equal(100_000); // Unchanged
    });
  });
});
