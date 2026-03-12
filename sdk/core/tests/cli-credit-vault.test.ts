/** Tests for Credit Vault CLI Commands (SVS-11): command registration, subcommands, options, PDA derivations */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

import { createCli } from "../src/cli/index";
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

describe("Credit Vault CLI (SVS-11)", () => {
  // ==========================================================================
  // Command Registration
  // ==========================================================================

  describe("Command Registration", () => {
    it("registers 'credit' as top-level command", () => {
      const program = createCli();
      const commands = program.commands.map((c) => c.name());
      expect(commands).to.include("credit");
    });

    it("credit command has correct description", () => {
      const program = createCli();
      const creditCmd = program.commands.find((c) => c.name() === "credit");
      expect(creditCmd).to.exist;
      expect(creditCmd!.description()).to.include("SVS-11");
    });

    it("credit command has all expected subcommands", () => {
      const program = createCli();
      const creditCmd = program.commands.find((c) => c.name() === "credit");
      expect(creditCmd).to.exist;

      const subcommands = creditCmd!.commands.map((c) => c.name());

      // View
      expect(subcommands).to.include("show");

      // Investor
      expect(subcommands).to.include("request-deposit");
      expect(subcommands).to.include("cancel-deposit");
      expect(subcommands).to.include("request-redeem");
      expect(subcommands).to.include("cancel-redeem");
      expect(subcommands).to.include("claim");

      // Manager
      expect(subcommands).to.include("approve-deposit");
      expect(subcommands).to.include("reject-deposit");
      expect(subcommands).to.include("approve-redeem");
      expect(subcommands).to.include("repay");

      // Compliance
      expect(subcommands).to.include("freeze");
      expect(subcommands).to.include("unfreeze");

      // Window + Admin (nested)
      expect(subcommands).to.include("window");
      expect(subcommands).to.include("admin");
    });

    it("window subcommand has open/close", () => {
      const program = createCli();
      const creditCmd = program.commands.find((c) => c.name() === "credit");
      const windowCmd = creditCmd!.commands.find((c) => c.name() === "window");
      expect(windowCmd).to.exist;
      const windowSubs = windowCmd!.commands.map((c) => c.name());
      expect(windowSubs).to.include("open");
      expect(windowSubs).to.include("close");
    });

    it("admin subcommand has expected sub-commands", () => {
      const program = createCli();
      const creditCmd = program.commands.find((c) => c.name() === "credit");
      const adminCmd = creditCmd!.commands.find((c) => c.name() === "admin");
      expect(adminCmd).to.exist;
      const adminSubs = adminCmd!.commands.map((c) => c.name());
      expect(adminSubs).to.include("pause");
      expect(adminSubs).to.include("unpause");
      expect(adminSubs).to.include("transfer-authority");
      expect(adminSubs).to.include("set-manager");
      expect(adminSubs).to.include("update-attester");
    });
  });

  // ==========================================================================
  // Command Options
  // ==========================================================================

  describe("Command Options", () => {
    function getSubcommand(name: string) {
      const program = createCli();
      const creditCmd = program.commands.find((c) => c.name() === "credit");
      return creditCmd!.commands.find((c) => c.name() === name);
    }

    function getOptionFlags(cmd: ReturnType<typeof getSubcommand>) {
      return cmd!.options.map((o: { flags: string }) => o.flags);
    }

    it("request-deposit requires --amount and --attestation", () => {
      const cmd = getSubcommand("request-deposit");
      const flags = getOptionFlags(cmd);
      expect(flags.some((f: string) => f.includes("--amount"))).to.be.true;
      expect(flags.some((f: string) => f.includes("--attestation"))).to.be.true;
    });

    it("approve-deposit requires --investor, --oracle, --attestation", () => {
      const cmd = getSubcommand("approve-deposit");
      const flags = getOptionFlags(cmd);
      expect(flags.some((f: string) => f.includes("--investor"))).to.be.true;
      expect(flags.some((f: string) => f.includes("--oracle"))).to.be.true;
      expect(flags.some((f: string) => f.includes("--attestation"))).to.be.true;
    });

    it("reject-deposit requires --investor", () => {
      const cmd = getSubcommand("reject-deposit");
      const flags = getOptionFlags(cmd);
      expect(flags.some((f: string) => f.includes("--investor"))).to.be.true;
    });

    it("request-redeem requires --shares and --attestation", () => {
      const cmd = getSubcommand("request-redeem");
      const flags = getOptionFlags(cmd);
      expect(flags.some((f: string) => f.includes("--shares"))).to.be.true;
      expect(flags.some((f: string) => f.includes("--attestation"))).to.be.true;
    });

    it("approve-redeem requires --investor and --oracle", () => {
      const cmd = getSubcommand("approve-redeem");
      const flags = getOptionFlags(cmd);
      expect(flags.some((f: string) => f.includes("--investor"))).to.be.true;
      expect(flags.some((f: string) => f.includes("--oracle"))).to.be.true;
    });

    it("repay requires --amount", () => {
      const cmd = getSubcommand("repay");
      const flags = getOptionFlags(cmd);
      expect(flags.some((f: string) => f.includes("--amount"))).to.be.true;
    });

    it("freeze requires --investor", () => {
      const cmd = getSubcommand("freeze");
      const flags = getOptionFlags(cmd);
      expect(flags.some((f: string) => f.includes("--investor"))).to.be.true;
    });

    it("all subcommands have common vault options", () => {
      const cmdsWithVaultOpts = [
        "show",
        "request-deposit",
        "cancel-deposit",
        "request-redeem",
        "cancel-redeem",
        "claim",
        "approve-deposit",
        "reject-deposit",
        "approve-redeem",
        "repay",
        "freeze",
        "unfreeze",
      ];

      for (const name of cmdsWithVaultOpts) {
        const cmd = getSubcommand(name);
        expect(cmd, `${name} not found`).to.exist;
        const flags = getOptionFlags(cmd);
        expect(
          flags.some((f: string) => f.includes("--program-id")),
          `${name} missing --program-id`,
        ).to.be.true;
        expect(
          flags.some((f: string) => f.includes("--asset-mint")),
          `${name} missing --asset-mint`,
        ).to.be.true;
        expect(
          flags.some((f: string) => f.includes("--vault-id")),
          `${name} missing --vault-id`,
        ).to.be.true;
      }
    });
  });

  // ==========================================================================
  // PDA Derivations (credit-pda integration)
  // ==========================================================================

  describe("PDA Derivations", () => {
    it("vault PDA is deterministic", () => {
      const [addr1] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [addr2] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      expect(addr1.equals(addr2)).to.be.true;
    });

    it("different vault IDs produce different addresses", () => {
      const [a1] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [a2] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
      expect(a1.equals(a2)).to.be.false;
    });

    it("investor-scoped PDAs differ by investor", () => {
      const [vault] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const investor2 = PublicKey.unique();

      const [ir1] = getInvestmentRequestAddress(PROGRAM_ID, vault, INVESTOR);
      const [ir2] = getInvestmentRequestAddress(PROGRAM_ID, vault, investor2);
      expect(ir1.equals(ir2)).to.be.false;
    });

    it("frozen account PDA is deterministic", () => {
      const [vault] = getCreditVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [f1] = getFrozenAccountAddress(PROGRAM_ID, vault, INVESTOR);
      const [f2] = getFrozenAccountAddress(PROGRAM_ID, vault, INVESTOR);
      expect(f1.equals(f2)).to.be.true;
    });

    it("batch derivation returns consistent results", () => {
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

    it("all seed constants have correct values", () => {
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

  // ==========================================================================
  // SvsVariant
  // ==========================================================================

  describe("SvsVariant", () => {
    it("includes svs-11 as valid variant", () => {
      // Type assertion — if svs-11 isn't in the union, this won't compile
      const variant: import("../src/cli/types").SvsVariant = "svs-11";
      expect(variant).to.equal("svs-11");
    });
  });
});
