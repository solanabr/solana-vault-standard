/** Tests for Extended CLI Commands: fees, caps, access, emergency, timelock, strategy, portfolio, ct */

import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { createCli } from "../src/cli/index";
import {
  FeeConfig,
  validateFeeConfig,
  calculateAccruedFees,
  createInitialFeeState,
} from "../src/fees";
import {
  CapConfig,
  checkDepositCap,
  maxDeposit,
  createCapConfig,
  createDisabledCapConfig,
  validateCapConfig,
} from "../src/cap";
import {
  AccessConfig,
  AccessMode,
  checkAccess,
  createOpenConfig,
  createWhitelistConfig,
  createBlacklistConfig,
  addToList,
  removeFromList,
  generateMerkleRoot,
  generateMerkleProof,
  verifyMerkleProof,
} from "../src/access-control";
import {
  EmergencyConfig,
  previewEmergencyRedeem,
  createEmergencyConfig,
  validateEmergencyConfig,
} from "../src/emergency";
import {
  TimelockConfig,
  TimelockAction,
  ProposalStatus,
  createTimelockConfig,
  validateTimelockConfig,
  createProposal,
  getProposalStatus,
  canExecute,
} from "../src/timelock";
import {
  StrategyType,
  StrategyStatus,
  createLendingStrategy,
  validateStrategyConfig,
  createInitialPosition,
} from "../src/strategy";
import {
  VaultAllocation,
  validateWeights,
  allocateDeposit,
  createMultiVaultConfig,
} from "../src/multi-asset";

describe("Extended CLI Commands", () => {
  describe("Fees Module", () => {
    it("validates fee config with valid values", () => {
      const config: FeeConfig = {
        managementFeeBps: 200, // 2%
        performanceFeeBps: 2000, // 20%
        entryFeeBps: 50, // 0.5%
        exitFeeBps: 50, // 0.5%
        feeRecipient: PublicKey.unique(),
      };

      expect(() => validateFeeConfig(config)).to.not.throw();
    });

    it("rejects fee config with bps > 10000", () => {
      const config: FeeConfig = {
        managementFeeBps: 15000, // Invalid
        performanceFeeBps: 2000,
        feeRecipient: PublicKey.unique(),
      };

      // validateFeeConfig returns false for invalid configs
      expect(validateFeeConfig(config)).to.be.false;
    });

    it("calculates accrued fees correctly", () => {
      const config: FeeConfig = {
        managementFeeBps: 200, // 2% annual
        performanceFeeBps: 0,
        feeRecipient: PublicKey.unique(),
      };

      const totalAssets = new BN(1_000_000);
      const totalShares = new BN(1_000_000);
      const oneYearAgo = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
      const feeState = createInitialFeeState(oneYearAgo);

      const result = calculateAccruedFees(
        totalAssets,
        totalShares,
        config,
        feeState,
        Math.floor(Date.now() / 1000),
      );

      // ~2% of 1M = 20,000 (approximately)
      expect(result.managementFee.toNumber()).to.be.closeTo(20000, 1000);
    });
  });

  describe("Cap Module", () => {
    it("validates cap config", () => {
      const config = createCapConfig(new BN(1_000_000), new BN(100_000));

      expect(() => validateCapConfig(config)).to.not.throw();
      expect(config.enabled).to.be.true;
      expect(config.globalCap?.toString()).to.equal("1000000");
      expect(config.perUserCap?.toString()).to.equal("100000");
    });

    it("creates disabled cap config", () => {
      const config = createDisabledCapConfig();

      expect(config.enabled).to.be.false;
      expect(config.globalCap).to.be.null;
      expect(config.perUserCap).to.be.null;
    });

    it("checkDepositCap allows deposit under limits", () => {
      const config = createCapConfig(new BN(1_000_000), new BN(100_000));
      const result = checkDepositCap(
        new BN(50_000), // deposit
        new BN(500_000), // current total
        new BN(25_000), // user current
        config,
      );

      expect(result.allowed).to.be.true;
      expect(result.reason).to.be.undefined;
    });

    it("checkDepositCap blocks deposit exceeding global cap", () => {
      const config = createCapConfig(new BN(1_000_000), null);
      const result = checkDepositCap(
        new BN(600_000), // deposit
        new BN(500_000), // current total = 1.1M total, exceeds 1M cap
        new BN(0),
        config,
      );

      expect(result.allowed).to.be.false;
      expect(result.reason).to.exist;
    });

    it("maxDeposit returns correct value", () => {
      const config = createCapConfig(new BN(1_000_000), new BN(100_000));
      const max = maxDeposit(
        new BN(900_000), // current total (100k remaining global)
        new BN(50_000), // user current (50k remaining user)
        config,
      );

      // Should be min(100k global remaining, 50k user remaining) = 50k
      expect(max.toNumber()).to.equal(50_000);
    });
  });

  describe("Access Control Module", () => {
    it("creates open access config", () => {
      const config = createOpenConfig();

      expect(config.mode).to.equal(AccessMode.Open);
    });

    it("creates whitelist config", () => {
      const addresses = [PublicKey.unique(), PublicKey.unique()];
      const config = createWhitelistConfig(addresses, false);

      expect(config.mode).to.equal(AccessMode.Whitelist);
      expect(config.addresses.size).to.equal(2);
    });

    it("creates blacklist config", () => {
      const addresses = [PublicKey.unique()];
      const config = createBlacklistConfig(addresses);

      expect(config.mode).to.equal(AccessMode.Blacklist);
    });

    it("adds address to list", () => {
      const config = createWhitelistConfig([], false);
      const newAddr = PublicKey.unique();
      const updated = addToList(config, newAddr);

      expect(updated.addresses.size).to.equal(1);
    });

    it("removes address from list", () => {
      const addr = PublicKey.unique();
      const config = createWhitelistConfig([addr], false);
      const updated = removeFromList(config, addr);

      expect(updated.addresses.size).to.equal(0);
    });

    it("checkAccess allows in open mode", () => {
      const config = createOpenConfig();
      const result = checkAccess(PublicKey.unique(), config);

      expect(result.allowed).to.be.true;
    });

    it("generates and verifies merkle proofs", () => {
      const addresses = [
        PublicKey.unique(),
        PublicKey.unique(),
        PublicKey.unique(),
        PublicKey.unique(),
      ];
      const root = generateMerkleRoot(addresses);
      const targetAddr = addresses[2];
      const proof = generateMerkleProof(targetAddr, addresses);

      expect(proof).to.not.be.null;
      if (proof) {
        const isValid = verifyMerkleProof(targetAddr, proof, root);
        expect(isValid).to.be.true;
      }
    });
  });

  describe("Emergency Module", () => {
    it("creates emergency config", () => {
      const penaltyRecipient = PublicKey.unique();
      const config = createEmergencyConfig(500, penaltyRecipient, {
        cooldownPeriod: 3600,
      });

      expect(config.penaltyBps).to.equal(500);
      expect(config.cooldownPeriod).to.equal(3600);
    });

    it("validates emergency config", () => {
      const penaltyRecipient = PublicKey.unique();
      const config = createEmergencyConfig(500, penaltyRecipient);

      expect(() => validateEmergencyConfig(config)).to.not.throw();
    });

    it("rejects penalty > 100%", () => {
      const penaltyRecipient = PublicKey.unique();
      const config = createEmergencyConfig(15000, penaltyRecipient); // 150% (invalid)

      // validateEmergencyConfig returns false for invalid configs
      expect(validateEmergencyConfig(config)).to.be.false;
    });

    it("previews emergency redeem with penalty", () => {
      const penaltyRecipient = PublicKey.unique();
      const config = createEmergencyConfig(1000, penaltyRecipient); // 10%

      // Use decimalsOffset=0 for simpler calculation (no virtual offset)
      const result = previewEmergencyRedeem(
        new BN(1_000), // shares
        new BN(1_000_000), // total assets
        new BN(1_000_000), // total shares
        0, // decimals offset (0 = no virtual offset)
        config,
      );

      // With no virtual offset: 1000 shares = 1001 assets (due to +1 virtualAssets)
      // Then 10% penalty = 100
      // grossAssets ~ 1001, penalty ~ 100, netAssets ~ 901
      expect(result.grossAssets.toNumber()).to.be.closeTo(1001, 1);
      expect(result.penalty.toNumber()).to.be.closeTo(100, 1);
      expect(result.netAssets.toNumber()).to.be.closeTo(901, 1);
    });
  });

  describe("Timelock Module", () => {
    it("creates timelock config", () => {
      const admin = PublicKey.unique();
      const config = createTimelockConfig(admin, {
        minDelay: 86400, // 1 day
        maxDelay: 604800, // 1 week
      });

      expect(config.admin.equals(admin)).to.be.true;
      expect(config.minDelay).to.equal(86400);
      expect(config.maxDelay).to.equal(604800);
    });

    it("validates timelock config", () => {
      const admin = PublicKey.unique();
      const config = createTimelockConfig(admin, { minDelay: 3600 });

      expect(validateTimelockConfig(config)).to.be.true;
    });

    it("creates and checks proposal status", () => {
      const admin = PublicKey.unique();
      const config = createTimelockConfig(admin, { minDelay: 3600 });
      const now = Math.floor(Date.now() / 1000);

      const proposal = createProposal(
        TimelockAction.TransferAuthority,
        { newAuthority: PublicKey.unique().toBase58() },
        config,
        now,
        3600,
      );

      expect(proposal.status).to.equal(ProposalStatus.Pending);
      expect(proposal.executeAfter).to.equal(now + 3600);

      // Check status before ETA
      const statusBefore = getProposalStatus(proposal, now + 1000);
      expect(statusBefore).to.equal(ProposalStatus.Pending);

      // Check status after ETA
      const statusAfter = getProposalStatus(proposal, now + 4000);
      expect(statusAfter).to.equal(ProposalStatus.Ready);
    });

    it("canExecute returns false before ETA", () => {
      const admin = PublicKey.unique();
      const config = createTimelockConfig(admin, { minDelay: 3600 });
      const now = Math.floor(Date.now() / 1000);

      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        config,
        now,
        3600,
      );

      const result = canExecute(proposal, now + 1800); // 30 min in
      expect(result.executable).to.be.false;
    });
  });

  describe("Strategy Module", () => {
    it("creates lending strategy", () => {
      const strategy = createLendingStrategy(
        "lending-1",
        "Kamino USDC",
        PublicKey.unique(),
        PublicKey.unique(),
        PublicKey.unique(),
      );

      expect(strategy.id).to.equal("lending-1");
      expect(strategy.name).to.equal("Kamino USDC");
      expect(strategy.type).to.equal(StrategyType.Lending);
      expect(strategy.status).to.equal(StrategyStatus.Active);
    });

    it("validates strategy config", () => {
      const strategy = createLendingStrategy(
        "lending-1",
        "Test",
        PublicKey.unique(),
        PublicKey.unique(),
        PublicKey.unique(),
      );

      expect(() => validateStrategyConfig(strategy)).to.not.throw();
    });

    it("creates initial position", () => {
      const now = Math.floor(Date.now() / 1000);
      const position = createInitialPosition("strategy-1", now);

      expect(position.strategyId).to.equal("strategy-1");
      expect(position.deployedAssets.toNumber()).to.equal(0);
      expect(position.receiptTokens.toNumber()).to.equal(0);
    });
  });

  describe("Multi-Asset Module", () => {
    it("validates weights summing to 100%", () => {
      const allocations: VaultAllocation[] = [
        { vault: PublicKey.unique(), targetWeight: 5000 },
        { vault: PublicKey.unique(), targetWeight: 5000 },
      ];

      expect(validateWeights(allocations)).to.be.true;
    });

    it("rejects weights not summing to 100%", () => {
      const allocations: VaultAllocation[] = [
        { vault: PublicKey.unique(), targetWeight: 5000 },
        { vault: PublicKey.unique(), targetWeight: 3000 },
      ];

      expect(validateWeights(allocations)).to.be.false;
    });

    it("allocates deposit according to weights", () => {
      const vault1 = PublicKey.unique();
      const vault2 = PublicKey.unique();
      const allocations: VaultAllocation[] = [
        { vault: vault1, targetWeight: 6000 }, // 60%
        { vault: vault2, targetWeight: 4000 }, // 40%
      ];

      const result = allocateDeposit(new BN(1_000_000), allocations);

      expect(result.get(vault1.toBase58())?.toNumber()).to.equal(600_000);
      expect(result.get(vault2.toBase58())?.toNumber()).to.equal(400_000);
    });

    it("creates multi-vault config", () => {
      const vault = PublicKey.unique();
      const allocations = [{ vault, weight: 10000 }];

      const config = createMultiVaultConfig(allocations);

      expect(config.allocations).to.have.length(1);
      expect(config.rebalanceThresholdBps).to.equal(500); // default
    });
  });

  describe("Command Registration", () => {
    it("all new commands are properly registered", () => {
      const program = createCli();
      const commands = program.commands.map((c) => c.name());

      // Verify all new commands exist
      const newCommands = [
        "ct",
        "fees",
        "cap",
        "access",
        "emergency",
        "timelock",
        "strategy",
        "portfolio",
      ];

      for (const cmd of newCommands) {
        expect(commands, `Missing command: ${cmd}`).to.include(cmd);
      }
    });

    it("ct configure command has vault argument", () => {
      const program = createCli();
      const ctCmd = program.commands.find((c) => c.name() === "ct");
      const configureCmd = ctCmd!.commands.find(
        (c) => c.name() === "configure",
      );

      expect(configureCmd).to.exist;
      expect(configureCmd!.registeredArguments[0].name()).to.equal("vault");
    });

    it("fees configure command has fee options", () => {
      const program = createCli();
      const feesCmd = program.commands.find((c) => c.name() === "fees");
      const configureCmd = feesCmd!.commands.find(
        (c) => c.name() === "configure",
      );

      expect(configureCmd).to.exist;
      const optionFlags = configureCmd!.options.map((o) => o.long);
      expect(optionFlags).to.include("--management");
      expect(optionFlags).to.include("--performance");
    });

    it("access set-mode command has mode option", () => {
      const program = createCli();
      const accessCmd = program.commands.find((c) => c.name() === "access");
      const setModeCmd = accessCmd!.commands.find(
        (c) => c.name() === "set-mode",
      );

      expect(setModeCmd).to.exist;
      const optionFlags = setModeCmd!.options.map((o) => o.long);
      expect(optionFlags).to.include("--mode");
    });

    it("timelock propose command has action option", () => {
      const program = createCli();
      const timelockCmd = program.commands.find((c) => c.name() === "timelock");
      const proposeCmd = timelockCmd!.commands.find(
        (c) => c.name() === "propose",
      );

      expect(proposeCmd).to.exist;
      const optionFlags = proposeCmd!.options.map((o) => o.long);
      expect(optionFlags).to.include("--action");
    });

    it("strategy add command has type option", () => {
      const program = createCli();
      const strategyCmd = program.commands.find((c) => c.name() === "strategy");
      const addCmd = strategyCmd!.commands.find((c) => c.name() === "add");

      expect(addCmd).to.exist;
      const optionFlags = addCmd!.options.map((o) => o.long);
      expect(optionFlags).to.include("--type");
      expect(optionFlags).to.include("--name");
    });

    it("portfolio configure command has allocations option", () => {
      const program = createCli();
      const portfolioCmd = program.commands.find(
        (c) => c.name() === "portfolio",
      );
      const configureCmd = portfolioCmd!.commands.find(
        (c) => c.name() === "configure",
      );

      expect(configureCmd).to.exist;
      const optionFlags = configureCmd!.options.map((o) => o.long);
      expect(optionFlags).to.include("--allocations");
    });
  });
});
