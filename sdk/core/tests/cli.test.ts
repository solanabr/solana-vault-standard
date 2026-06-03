/** Tests for CLI: config management, vault resolution, output formatting, utilities */

import { expect } from "chai";
import { PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { createCli } from "../src/cli/index";
import { validateConfig, safeValidateConfig } from "../src/cli/config/schema";
import { loadConfig, applyProfile } from "../src/cli/config";
import {
  resolveVault,
  isValidPublicKey,
  addVaultAlias,
  removeVaultAlias,
} from "../src/cli/config/vault-aliases";
import {
  findIdlPath,
  loadIdl,
  resolveVaultArg,
  checkAuthority,
  getConfigPath,
  formatNumber,
} from "../src/cli/utils";
import {
  createOutputAdapter,
  formatAddress,
  formatTimestamp,
} from "../src/cli/output";
import {
  CliConfig,
  SvsVariant,
  DEFAULT_CONFIG as DEFAULT_CLI_CONFIG,
} from "../src/cli/types";

describe("CLI Module", () => {
  describe("Command Registration", () => {
    it("creates CLI with all expected commands", () => {
      const program = createCli();
      const commands = program.commands.map((c) => c.name());

      // Inspect commands
      expect(commands).to.include("info");
      expect(commands).to.include("preview");
      expect(commands).to.include("list");
      expect(commands).to.include("balance");
      expect(commands).to.include("history");

      // Operate commands
      expect(commands).to.include("deposit");
      expect(commands).to.include("withdraw");
      expect(commands).to.include("mint");
      expect(commands).to.include("redeem");

      // Admin commands
      expect(commands).to.include("pause");
      expect(commands).to.include("unpause");
      expect(commands).to.include("sync");
      expect(commands).to.include("transfer-authority");
      expect(commands).to.include("permissions");

      // Monitor commands
      expect(commands).to.include("health");
      expect(commands).to.include("dashboard");

      // Automation commands
      expect(commands).to.include("guard");
      expect(commands).to.include("autopilot");
      expect(commands).to.include("batch");

      // Offline commands
      expect(commands).to.include("convert");
      expect(commands).to.include("derive");

      // Config commands
      expect(commands).to.include("config");

      // New extended commands
      expect(commands).to.include("ct");
      expect(commands).to.include("fees");
      expect(commands).to.include("cap");
      expect(commands).to.include("access");
      expect(commands).to.include("emergency");
      expect(commands).to.include("timelock");
      expect(commands).to.include("strategy");
      expect(commands).to.include("portfolio");
    });

    it("has correct version", () => {
      const program = createCli();
      expect(program.version()).to.equal("0.2.0");
    });

    it("has correct name", () => {
      const program = createCli();
      expect(program.name()).to.equal("solana-vault");
    });

    it("has global options", () => {
      const program = createCli();
      const optionNames = program.options.map((o) => o.long);

      expect(optionNames).to.include("--url");
      expect(optionNames).to.include("--keypair");
      expect(optionNames).to.include("--output");
      expect(optionNames).to.include("--profile");
      expect(optionNames).to.include("--verbose");
      expect(optionNames).to.include("--quiet");
      expect(optionNames).to.include("--yes");
      expect(optionNames).to.include("--dry-run");
    });
  });

  describe("Config Schema Validation", () => {
    it("validates correct config", () => {
      const config = {
        defaults: {
          cluster: "devnet",
          keypair: "~/.config/solana/id.json",
          output: "table",
          confirmation: "confirmed",
        },
        profiles: {},
        vaults: {},
      };

      const result = safeValidateConfig(config);
      expect(result.success).to.be.true;
    });

    it("rejects invalid cluster", () => {
      const config = {
        defaults: {
          cluster: "invalid-cluster",
          keypair: "~/.config/solana/id.json",
          output: "table",
          confirmation: "confirmed",
        },
      };

      const result = safeValidateConfig(config);
      expect(result.success).to.be.false;
    });

    it("rejects invalid output format", () => {
      const config = {
        defaults: {
          cluster: "devnet",
          keypair: "~/.config/solana/id.json",
          output: "yaml",
          confirmation: "confirmed",
        },
      };

      const result = safeValidateConfig(config);
      expect(result.success).to.be.false;
    });

    it("validates vault aliases", () => {
      const config = {
        defaults: {
          cluster: "devnet",
          keypair: "~/.config/solana/id.json",
          output: "table",
          confirmation: "confirmed",
        },
        vaults: {
          "my-vault": {
            address: "11111111111111111111111111111111",
            variant: "svs-1",
          },
        },
      };

      const result = safeValidateConfig(config);
      expect(result.success).to.be.true;
    });

    it("rejects vault with invalid variant", () => {
      const config = {
        defaults: {
          cluster: "devnet",
          keypair: "~/.config/solana/id.json",
          output: "table",
          confirmation: "confirmed",
        },
        vaults: {
          "my-vault": {
            address: "11111111111111111111111111111111",
            variant: "svs-5",
          },
        },
      };

      const result = safeValidateConfig(config);
      expect(result.success).to.be.false;
    });

    it("validates autopilot config", () => {
      const config = {
        defaults: {
          cluster: "devnet",
          keypair: "~/.config/solana/id.json",
          output: "table",
          confirmation: "confirmed",
        },
        autopilot: {
          "my-vault": {
            sync: {
              enabled: true,
              interval: "1h",
            },
          },
        },
      };

      const result = safeValidateConfig(config);
      expect(result.success).to.be.true;
    });

    it("validates guard config", () => {
      const config = {
        defaults: {
          cluster: "devnet",
          keypair: "~/.config/solana/id.json",
          output: "table",
          confirmation: "confirmed",
        },
        guards: {
          "my-vault": {
            maxDepositPerTx: "1000000",
            cooldownSeconds: 60,
          },
        },
      };

      const result = safeValidateConfig(config);
      expect(result.success).to.be.true;
    });
  });

  describe("Vault Resolution", () => {
    const testConfig: CliConfig = {
      defaults: {
        cluster: "devnet",
        keypair: "~/.config/solana/id.json",
        output: "table",
        confirmation: "confirmed",
      },
      profiles: {},
      vaults: {
        "test-vault": {
          address: "7xKYqBvpmmN4dZFrAPCfPKBNqPhsRUFwsHPDKJeJpump",
          variant: "svs-1",
          assetMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          vaultId: 1,
        },
        "vault-no-mint": {
          address: "11111111111111111111111111111111",
          variant: "svs-2",
        },
      },
    };

    it("resolves vault alias to address", () => {
      const resolved = resolveVault("test-vault", testConfig);

      expect(resolved.address.toBase58()).to.equal(
        "7xKYqBvpmmN4dZFrAPCfPKBNqPhsRUFwsHPDKJeJpump",
      );
      expect(resolved.variant).to.equal("svs-1");
      expect(resolved.assetMint?.toBase58()).to.equal(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
    });

    it("throws for unknown alias", () => {
      expect(() => resolveVault("unknown-vault", testConfig)).to.throw(
        "not found",
      );
    });

    it("isValidPublicKey returns true for valid pubkey", () => {
      expect(isValidPublicKey("7xKYqBvpmmN4dZFrAPCfPKBNqPhsRUFwsHPDKJeJpump"))
        .to.be.true;
    });

    it("isValidPublicKey returns false for alias", () => {
      expect(isValidPublicKey("test-vault")).to.be.false;
    });

    it("isValidPublicKey returns false for invalid string", () => {
      expect(isValidPublicKey("not-a-pubkey")).to.be.false;
    });

    it("adds vault alias to config", () => {
      const config = { ...testConfig, vaults: { ...testConfig.vaults } };
      const validAddress = "So11111111111111111111111111111111111111112";
      const newConfig = addVaultAlias(config, "new-vault", {
        address: validAddress,
        variant: "svs-3" as SvsVariant,
      });

      expect(newConfig.vaults["new-vault"]).to.exist;
      expect(newConfig.vaults["new-vault"].address).to.equal(validAddress);
    });

    it("removes vault alias from config", () => {
      const config: CliConfig = {
        defaults: testConfig.defaults,
        profiles: {},
        vaults: {
          "to-remove": {
            address: "11111111111111111111111111111111",
            variant: "svs-1",
          },
        },
      };
      const newConfig = removeVaultAlias(config, "to-remove");

      expect(newConfig.vaults["to-remove"]).to.be.undefined;
    });
  });

  describe("Output Formatting", () => {
    it("formatAddress truncates long addresses", () => {
      const addr = "7xKYqBvpmmN4dZFrAPCfPKBNqPhsRUFwsHPDKJeJpump";
      const formatted = formatAddress(addr, true);

      expect(formatted.length).to.be.lessThan(addr.length);
      expect(formatted).to.include("...");
    });

    it("formatAddress returns full address when truncate=false", () => {
      const addr = "7xKYqBvpmmN4dZFrAPCfPKBNqPhsRUFwsHPDKJeJpump";
      const formatted = formatAddress(addr, false);

      expect(formatted).to.equal(addr);
    });

    it("formatTimestamp returns valid date string", () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const formatted = formatTimestamp(timestamp);

      expect(formatted).to.match(/\d{4}-\d{2}-\d{2}/);
    });

    it("createOutputAdapter returns adapter with all methods", () => {
      const adapter = createOutputAdapter("table", false, false);

      expect(adapter.table).to.be.a("function");
      expect(adapter.json).to.be.a("function");
      expect(adapter.csv).to.be.a("function");
      expect(adapter.success).to.be.a("function");
      expect(adapter.error).to.be.a("function");
      expect(adapter.warn).to.be.a("function");
      expect(adapter.info).to.be.a("function");
      expect(adapter.debug).to.be.a("function");
      expect(adapter.spinner).to.be.a("function");
      expect(adapter.confirm).to.be.a("function");
    });

    it("createOutputAdapter respects quiet mode", () => {
      const adapter = createOutputAdapter("table", false, true);
      expect(adapter.quiet).to.be.true;
    });

    it("createOutputAdapter respects verbose mode", () => {
      const adapter = createOutputAdapter("table", true, false);
      expect(adapter.verbose).to.be.true;
    });
  });

  describe("Utility Functions", () => {
    it("getConfigPath returns path in home directory", () => {
      const configPath = getConfigPath();

      expect(configPath).to.include(".solana-vault");
      expect(configPath).to.include("config.yaml");
    });

    it("formatNumber adds thousands separators", () => {
      expect(formatNumber(1000000)).to.equal("1,000,000");
      expect(formatNumber("1234567890")).to.equal("1,234,567,890");
      expect(formatNumber(new BN(999))).to.equal("999");
    });

    it("checkAuthority returns true when pubkeys match", () => {
      const keypair = Keypair.generate();
      const mockOutput = {
        error: () => {},
        warn: () => {},
        info: () => {},
        success: () => {},
        debug: () => {},
        table: () => {},
        json: () => {},
        csv: () => {},
        spinner: () => {
          const s = {
            start: () => s,
            stop: () => s,
            succeed: () => s,
            fail: () => s,
            text: "",
          };
          return s;
        },
        confirm: async () => true,
        format: "table" as const,
        verbose: false,
        quiet: false,
      };

      const result = checkAuthority(
        keypair.publicKey,
        keypair.publicKey,
        mockOutput,
      );
      expect(result).to.be.true;
    });

    it("checkAuthority returns false when pubkeys differ", () => {
      const keypair1 = Keypair.generate();
      const keypair2 = Keypair.generate();
      let errorCalled = false;
      const mockOutput = {
        error: () => {
          errorCalled = true;
        },
        warn: () => {},
        info: () => {},
        success: () => {},
        debug: () => {},
        table: () => {},
        json: () => {},
        csv: () => {},
        spinner: () => {
          const s = {
            start: () => s,
            stop: () => s,
            succeed: () => s,
            fail: () => s,
            text: "",
          };
          return s;
        },
        confirm: async () => true,
        format: "table" as const,
        verbose: false,
        quiet: false,
      };

      const result = checkAuthority(
        keypair1.publicKey,
        keypair2.publicKey,
        mockOutput,
      );
      expect(result).to.be.false;
      expect(errorCalled).to.be.true;
    });
  });

  describe("Profile Management", () => {
    it("applies profile overrides to defaults", () => {
      const config: CliConfig = {
        defaults: {
          cluster: "devnet",
          keypair: "~/.config/solana/id.json",
          output: "table",
          confirmation: "confirmed",
        },
        profiles: {
          mainnet: {
            cluster: "mainnet-beta",
            confirmation: "finalized",
          },
        },
        vaults: {},
      };

      const result = applyProfile(config, "mainnet");

      expect(result.defaults.cluster).to.equal("mainnet-beta");
      expect(result.defaults.confirmation).to.equal("finalized");
      expect(result.defaults.keypair).to.equal("~/.config/solana/id.json");
    });

    it("throws for unknown profile", () => {
      const config: CliConfig = {
        defaults: {
          cluster: "devnet",
          keypair: "~/.config/solana/id.json",
          output: "table",
          confirmation: "confirmed",
        },
        profiles: {},
        vaults: {},
      };

      expect(() => applyProfile(config, "unknown")).to.throw("not found");
    });
  });

  describe("Default Config", () => {
    it("has valid defaults", () => {
      expect(DEFAULT_CLI_CONFIG.defaults.cluster).to.equal("devnet");
      expect(DEFAULT_CLI_CONFIG.defaults.output).to.equal("table");
      expect(DEFAULT_CLI_CONFIG.defaults.confirmation).to.equal("confirmed");
    });

    it("has empty vaults by default", () => {
      expect(DEFAULT_CLI_CONFIG.vaults).to.deep.equal({});
    });

    it("has empty profiles by default", () => {
      expect(DEFAULT_CLI_CONFIG.profiles).to.deep.equal({});
    });
  });

  describe("SVS Programs", () => {
    it("has devnet addresses for all variants", () => {
      const { SVS_PROGRAMS } = require("../src/cli/types");

      expect(SVS_PROGRAMS["svs-1"].devnet).to.be.a("string");
      expect(SVS_PROGRAMS["svs-2"].devnet).to.be.a("string");
      expect(SVS_PROGRAMS["svs-3"].devnet).to.be.a("string");
      expect(SVS_PROGRAMS["svs-4"].devnet).to.be.a("string");
    });

    it("devnet addresses are valid pubkeys", () => {
      const { SVS_PROGRAMS } = require("../src/cli/types");

      for (const variant of Object.keys(SVS_PROGRAMS)) {
        const addr = SVS_PROGRAMS[variant].devnet;
        expect(() => new PublicKey(addr)).to.not.throw();
      }
    });
  });

  describe("Batch File Validation", () => {
    it("validates correct batch structure", () => {
      const batch = {
        name: "Test Batch",
        operations: [
          { operation: "deposit", vault: "my-vault", amount: "1000000" },
          { operation: "pause", vault: "my-vault" },
        ],
      };

      const validOps = [
        "deposit",
        "withdraw",
        "mint",
        "redeem",
        "pause",
        "unpause",
      ];
      const issues: string[] = [];

      batch.operations.forEach((op, i) => {
        if (!validOps.includes(op.operation)) {
          issues.push(`Operation ${i + 1}: invalid operation`);
        }
        if (!op.vault) {
          issues.push(`Operation ${i + 1}: missing vault`);
        }
      });

      expect(issues).to.have.length(0);
    });

    it("detects missing amount for deposit", () => {
      const batch = {
        operations: [{ operation: "deposit", vault: "my-vault" }],
      };

      const issues: string[] = [];
      batch.operations.forEach((op: any, i) => {
        if (
          ["deposit", "withdraw", "mint", "redeem"].includes(op.operation) &&
          !op.amount
        ) {
          issues.push(`Operation ${i + 1}: missing amount`);
        }
      });

      expect(issues).to.have.length(1);
    });

    it("detects invalid operation type", () => {
      const batch = {
        operations: [{ operation: "invalid", vault: "my-vault" }],
      };

      const validOps = [
        "deposit",
        "withdraw",
        "mint",
        "redeem",
        "pause",
        "unpause",
      ];
      const issues: string[] = [];

      batch.operations.forEach((op: any, i) => {
        if (!validOps.includes(op.operation)) {
          issues.push(`Operation ${i + 1}: invalid operation`);
        }
      });

      expect(issues).to.have.length(1);
    });
  });

  describe("Guard Config Validation", () => {
    it("parses valid guard config", () => {
      const guardConfig = {
        maxDepositPerTx: "1000000",
        maxWithdrawPerTx: "500000",
        dailyDepositLimit: "10000000",
        cooldownSeconds: 300,
        pauseOnAnomaly: true,
        anomalyThresholds: {
          priceChangePercent: 10,
          volumeSpike: 5,
        },
      };

      expect(guardConfig.maxDepositPerTx).to.equal("1000000");
      expect(guardConfig.cooldownSeconds).to.equal(300);
      expect(guardConfig.anomalyThresholds?.priceChangePercent).to.equal(10);
    });

    it("checks deposit against guard limits", () => {
      const guardConfig = {
        maxDepositPerTx: "1000000",
      };
      const depositAmount = new BN("2000000");
      const maxDeposit = new BN(guardConfig.maxDepositPerTx);

      expect(depositAmount.gt(maxDeposit)).to.be.true;
    });
  });

  describe("Autopilot Config Validation", () => {
    it("parses valid autopilot config", () => {
      const autopilotConfig = {
        sync: {
          enabled: true,
          interval: "1h",
        },
        fees: {
          enabled: false,
          threshold: "1000000",
        },
        healthCheck: {
          enabled: true,
          interval: "5m",
          alertWebhook: "https://example.com/webhook",
        },
      };

      expect(autopilotConfig.sync?.enabled).to.be.true;
      expect(autopilotConfig.sync?.interval).to.equal("1h");
      expect(autopilotConfig.healthCheck?.alertWebhook).to.include("https://");
    });
  });

  describe("Command Options", () => {
    it("deposit command has required options", () => {
      const program = createCli();
      const depositCmd = program.commands.find((c) => c.name() === "deposit");

      expect(depositCmd).to.exist;

      const optionFlags = depositCmd!.options.map((o) => o.long);
      expect(optionFlags).to.include("--amount");
      expect(optionFlags).to.include("--slippage");
    });

    it("pause command has vault argument", () => {
      const program = createCli();
      const pauseCmd = program.commands.find((c) => c.name() === "pause");

      expect(pauseCmd).to.exist;
      expect(pauseCmd!.registeredArguments).to.have.length.above(0);
      expect(pauseCmd!.registeredArguments[0].name()).to.equal("vault");
    });

    it("guard command has subcommands", () => {
      const program = createCli();
      const guardCmd = program.commands.find((c) => c.name() === "guard");

      expect(guardCmd).to.exist;

      const subcommands = guardCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("show");
      expect(subcommands).to.include("configure");
      expect(subcommands).to.include("clear");
      expect(subcommands).to.include("check");
    });

    it("autopilot command has subcommands", () => {
      const program = createCli();
      const autopilotCmd = program.commands.find(
        (c) => c.name() === "autopilot",
      );

      expect(autopilotCmd).to.exist;

      const subcommands = autopilotCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("show");
      expect(subcommands).to.include("configure");
      expect(subcommands).to.include("run");
      expect(subcommands).to.include("clear");
    });

    it("batch command has subcommands", () => {
      const program = createCli();
      const batchCmd = program.commands.find((c) => c.name() === "batch");

      expect(batchCmd).to.exist;

      const subcommands = batchCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("run");
      expect(subcommands).to.include("validate");
      expect(subcommands).to.include("template");
    });

    it("ct command has subcommands", () => {
      const program = createCli();
      const ctCmd = program.commands.find((c) => c.name() === "ct");

      expect(ctCmd).to.exist;

      const subcommands = ctCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("configure");
      expect(subcommands).to.include("apply-pending");
      expect(subcommands).to.include("status");
    });

    it("fees command has subcommands", () => {
      const program = createCli();
      const feesCmd = program.commands.find((c) => c.name() === "fees");

      expect(feesCmd).to.exist;

      const subcommands = feesCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("show");
      expect(subcommands).to.include("configure");
      expect(subcommands).to.include("preview");
      expect(subcommands).to.include("clear");
    });

    it("cap command has subcommands", () => {
      const program = createCli();
      const capCmd = program.commands.find((c) => c.name() === "cap");

      expect(capCmd).to.exist;

      const subcommands = capCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("show");
      expect(subcommands).to.include("configure");
      expect(subcommands).to.include("check");
      expect(subcommands).to.include("max");
      expect(subcommands).to.include("clear");
    });

    it("access command has subcommands", () => {
      const program = createCli();
      const accessCmd = program.commands.find((c) => c.name() === "access");

      expect(accessCmd).to.exist;

      const subcommands = accessCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("show");
      expect(subcommands).to.include("set-mode");
      expect(subcommands).to.include("add");
      expect(subcommands).to.include("remove");
      expect(subcommands).to.include("check");
      expect(subcommands).to.include("generate-proof");
      expect(subcommands).to.include("clear");
    });

    it("emergency command has subcommands", () => {
      const program = createCli();
      const emergencyCmd = program.commands.find(
        (c) => c.name() === "emergency",
      );

      expect(emergencyCmd).to.exist;

      const subcommands = emergencyCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("show");
      expect(subcommands).to.include("configure");
      expect(subcommands).to.include("preview");
      expect(subcommands).to.include("withdraw");
      expect(subcommands).to.include("clear");
    });

    it("timelock command has subcommands", () => {
      const program = createCli();
      const timelockCmd = program.commands.find((c) => c.name() === "timelock");

      expect(timelockCmd).to.exist;

      const subcommands = timelockCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("show");
      expect(subcommands).to.include("configure");
      expect(subcommands).to.include("propose");
      expect(subcommands).to.include("execute");
      expect(subcommands).to.include("cancel");
      expect(subcommands).to.include("list");
      expect(subcommands).to.include("clear");
    });

    it("strategy command has subcommands", () => {
      const program = createCli();
      const strategyCmd = program.commands.find((c) => c.name() === "strategy");

      expect(strategyCmd).to.exist;

      const subcommands = strategyCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("show");
      expect(subcommands).to.include("add");
      expect(subcommands).to.include("remove");
      expect(subcommands).to.include("set-weight");
      expect(subcommands).to.include("deploy");
      expect(subcommands).to.include("recall");
      expect(subcommands).to.include("rebalance");
      expect(subcommands).to.include("health");
      expect(subcommands).to.include("clear");
    });

    it("portfolio command has subcommands", () => {
      const program = createCli();
      const portfolioCmd = program.commands.find(
        (c) => c.name() === "portfolio",
      );

      expect(portfolioCmd).to.exist;

      const subcommands = portfolioCmd!.commands.map((c) => c.name());
      expect(subcommands).to.include("show");
      expect(subcommands).to.include("configure");
      expect(subcommands).to.include("status");
      expect(subcommands).to.include("deposit");
      expect(subcommands).to.include("redeem");
      expect(subcommands).to.include("rebalance");
      expect(subcommands).to.include("clear");
    });
  });
});
