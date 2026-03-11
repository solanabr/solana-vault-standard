/** Tests for Async Vault CLI Commands (SVS-10): command registration, subcommands, options, arguments */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

import { createCli } from "../src/cli/index";
import { SVS_PROGRAMS, SvsVariant } from "../src/cli/types";
import {
  getAsyncVaultAddress,
  getAsyncSharesMintAddress,
  getAssetVaultAddress,
  getShareEscrowAddress,
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableEscrowAddress,
  getClaimableTokensAddress,
  getOperatorApprovalAddress,
  getOraclePriceAddress,
  deriveAsyncVaultAddresses,
  ASYNC_VAULT_SEED,
  ASYNC_SHARES_MINT_SEED,
  ASSET_VAULT_SEED,
  SHARE_ESCROW_SEED,
  DEPOSIT_REQUEST_SEED,
  REDEEM_REQUEST_SEED,
  CLAIMABLE_SEED,
  CLAIMABLE_TOKENS_SEED,
  OPERATOR_APPROVAL_SEED,
  ORACLE_PRICE_SEED,
} from "../src/async-pda";

const PROGRAM_ID = new PublicKey(SVS_PROGRAMS["svs-10"].devnet);
const ASSET_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const OWNER = new PublicKey("11111111111111111111111111111112");
const OPERATOR = new PublicKey("22222222222222222222222222222222222222222222");

describe("Async Vault CLI (SVS-10)", () => {
  // ==========================================================================
  // Command Registration
  // ==========================================================================

  describe("Command Registration", () => {
    it("registers 'async' as top-level command", () => {
      const program = createCli();
      const commands = program.commands.map((c) => c.name());
      expect(commands).to.include("async");
    });

    it("async command has correct description", () => {
      const program = createCli();
      const asyncCmd = program.commands.find((c) => c.name() === "async");
      expect(asyncCmd).to.exist;
      expect(asyncCmd!.description()).to.include("SVS-10");
    });

    it("async command has all 11 subcommands", () => {
      const program = createCli();
      const asyncCmd = program.commands.find((c) => c.name() === "async");
      expect(asyncCmd).to.exist;

      const subcommands = asyncCmd!.commands.map((c) => c.name());

      // User commands
      expect(subcommands).to.include("request-deposit");
      expect(subcommands).to.include("cancel-deposit");
      expect(subcommands).to.include("request-redeem");
      expect(subcommands).to.include("cancel-redeem");

      // Claim commands
      expect(subcommands).to.include("claim-deposit");
      expect(subcommands).to.include("claim-redeem");

      // Operator commands
      expect(subcommands).to.include("fulfill-deposit");
      expect(subcommands).to.include("fulfill-redeem");

      // Admin commands
      expect(subcommands).to.include("init-oracle");
      expect(subcommands).to.include("update-oracle");

      // View commands
      expect(subcommands).to.include("show-request");

      expect(subcommands).to.have.lengthOf(11);
    });
  });

  // ==========================================================================
  // Command Options & Arguments
  // ==========================================================================

  describe("Command Options", () => {
    let asyncCmd: ReturnType<typeof createCli>["commands"][0];

    before(() => {
      const program = createCli();
      asyncCmd = program.commands.find((c) => c.name() === "async")!;
    });

    const getSubcommand = (name: string) =>
      asyncCmd.commands.find((c) => c.name() === name);

    it("request-deposit has required --amount and vault argument", () => {
      const cmd = getSubcommand("request-deposit");
      expect(cmd).to.exist;

      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--amount");

      expect(cmd!.registeredArguments).to.have.length.above(0);
      expect(cmd!.registeredArguments[0].name()).to.equal("vault");
    });

    it("request-deposit has optional --receiver, --program-id, --asset-mint, --vault-id", () => {
      const cmd = getSubcommand("request-deposit");
      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--receiver");
      expect(opts).to.include("--program-id");
      expect(opts).to.include("--asset-mint");
      expect(opts).to.include("--vault-id");
    });

    it("request-redeem has required --shares and vault argument", () => {
      const cmd = getSubcommand("request-redeem");
      expect(cmd).to.exist;

      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--shares");

      expect(cmd!.registeredArguments).to.have.length.above(0);
      expect(cmd!.registeredArguments[0].name()).to.equal("vault");
    });

    it("fulfill-deposit has required --owner option", () => {
      const cmd = getSubcommand("fulfill-deposit");
      expect(cmd).to.exist;

      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--owner");
    });

    it("fulfill-redeem has required --owner option", () => {
      const cmd = getSubcommand("fulfill-redeem");
      expect(cmd).to.exist;

      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--owner");
    });

    it("init-oracle has required --price option", () => {
      const cmd = getSubcommand("init-oracle");
      expect(cmd).to.exist;

      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--price");
    });

    it("update-oracle has required --price option", () => {
      const cmd = getSubcommand("update-oracle");
      expect(cmd).to.exist;

      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--price");
    });

    it("init-oracle has optional --oracle-authority", () => {
      const cmd = getSubcommand("init-oracle");
      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--oracle-authority");
    });

    it("show-request has optional --owner", () => {
      const cmd = getSubcommand("show-request");
      expect(cmd).to.exist;

      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--owner");
    });

    it("cancel-deposit has vault argument", () => {
      const cmd = getSubcommand("cancel-deposit");
      expect(cmd).to.exist;
      expect(cmd!.registeredArguments).to.have.length.above(0);
      expect(cmd!.registeredArguments[0].name()).to.equal("vault");
    });

    it("cancel-redeem has vault argument", () => {
      const cmd = getSubcommand("cancel-redeem");
      expect(cmd).to.exist;
      expect(cmd!.registeredArguments).to.have.length.above(0);
      expect(cmd!.registeredArguments[0].name()).to.equal("vault");
    });

    it("claim-deposit has optional --owner", () => {
      const cmd = getSubcommand("claim-deposit");
      expect(cmd).to.exist;
      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--owner");
    });

    it("claim-redeem has optional --owner", () => {
      const cmd = getSubcommand("claim-redeem");
      expect(cmd).to.exist;
      const opts = cmd!.options.map((o) => o.long);
      expect(opts).to.include("--owner");
    });

    it("all subcommands accept vault as first argument", () => {
      for (const sub of asyncCmd.commands) {
        expect(
          sub.registeredArguments.length,
          `${sub.name()} should have arguments`,
        ).to.be.above(0);
        expect(sub.registeredArguments[0].name()).to.equal("vault");
      }
    });
  });

  // ==========================================================================
  // SVS-10 Program Registration
  // ==========================================================================

  describe("Program Registration", () => {
    it("SVS_PROGRAMS includes svs-10 variant", () => {
      expect(SVS_PROGRAMS).to.have.property("svs-10");
    });

    it("svs-10 has devnet program ID", () => {
      expect(SVS_PROGRAMS["svs-10"].devnet).to.equal(
        "E6gqyoVDQ33cWFJ9LpdSu68fNw6EKmoKR4db288RpFgJ",
      );
    });

    it("svs-10 is valid SvsVariant", () => {
      const variant: SvsVariant = "svs-10";
      expect(variant).to.equal("svs-10");
      expect(Object.keys(SVS_PROGRAMS)).to.include("svs-10");
    });
  });

  // ==========================================================================
  // PDA Seed Constants
  // ==========================================================================

  describe("PDA Seed Constants", () => {
    it("all seed buffers are non-empty", () => {
      const seeds = [
        ASYNC_VAULT_SEED,
        ASYNC_SHARES_MINT_SEED,
        ASSET_VAULT_SEED,
        SHARE_ESCROW_SEED,
        DEPOSIT_REQUEST_SEED,
        REDEEM_REQUEST_SEED,
        CLAIMABLE_SEED,
        CLAIMABLE_TOKENS_SEED,
        OPERATOR_APPROVAL_SEED,
        ORACLE_PRICE_SEED,
      ];
      for (const s of seeds) {
        expect(s.length).to.be.above(0);
        expect(Buffer.isBuffer(s)).to.be.true;
      }
    });

    it("seed values match Rust program constants", () => {
      expect(ASYNC_VAULT_SEED.toString()).to.equal("async_vault");
      expect(DEPOSIT_REQUEST_SEED.toString()).to.equal("deposit_request");
      expect(REDEEM_REQUEST_SEED.toString()).to.equal("redeem_request");
      expect(CLAIMABLE_TOKENS_SEED.toString()).to.equal("claimable_tokens");
      expect(OPERATOR_APPROVAL_SEED.toString()).to.equal("operator_approval");
      expect(ORACLE_PRICE_SEED.toString()).to.equal("oracle_price");
      expect(ASSET_VAULT_SEED.toString()).to.equal("asset_vault");
      expect(SHARE_ESCROW_SEED.toString()).to.equal("share_escrow");
      expect(CLAIMABLE_SEED.toString()).to.equal("claimable");
      expect(ASYNC_SHARES_MINT_SEED.toString()).to.equal("shares");
    });
  });

  // ==========================================================================
  // PDA Cross-Vault Isolation
  // ==========================================================================

  describe("PDA Cross-Vault Isolation", () => {
    let vault1: PublicKey;
    let vault2: PublicKey;

    before(() => {
      [vault1] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      [vault2] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 2);
    });

    it("deposit requests for different vaults are distinct", () => {
      const [d1] = getDepositRequestAddress(PROGRAM_ID, vault1, OWNER);
      const [d2] = getDepositRequestAddress(PROGRAM_ID, vault2, OWNER);
      expect(d1.equals(d2)).to.be.false;
    });

    it("redeem requests for different vaults are distinct", () => {
      const [r1] = getRedeemRequestAddress(PROGRAM_ID, vault1, OWNER);
      const [r2] = getRedeemRequestAddress(PROGRAM_ID, vault2, OWNER);
      expect(r1.equals(r2)).to.be.false;
    });

    it("claimable escrows for different vaults are distinct", () => {
      const [c1] = getClaimableEscrowAddress(PROGRAM_ID, vault1, OWNER);
      const [c2] = getClaimableEscrowAddress(PROGRAM_ID, vault2, OWNER);
      expect(c1.equals(c2)).to.be.false;
    });

    it("claimable tokens for different vaults are distinct", () => {
      const [t1] = getClaimableTokensAddress(PROGRAM_ID, vault1, OWNER);
      const [t2] = getClaimableTokensAddress(PROGRAM_ID, vault2, OWNER);
      expect(t1.equals(t2)).to.be.false;
    });

    it("oracle prices for different vaults are distinct", () => {
      const [o1] = getOraclePriceAddress(PROGRAM_ID, vault1);
      const [o2] = getOraclePriceAddress(PROGRAM_ID, vault2);
      expect(o1.equals(o2)).to.be.false;
    });

    it("operator approvals for different operators are distinct", () => {
      const [a1] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault1,
        OWNER,
        OPERATOR,
      );
      const [a2] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault1,
        OWNER,
        ASSET_MINT,
      );
      expect(a1.equals(a2)).to.be.false;
    });
  });

  // ==========================================================================
  // deriveAsyncVaultAddresses Integration
  // ==========================================================================

  describe("deriveAsyncVaultAddresses", () => {
    it("returns all vault-level addresses", () => {
      const addrs = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);

      expect(addrs).to.have.property("vault");
      expect(addrs).to.have.property("sharesMint");
      expect(addrs).to.have.property("assetVault");
      expect(addrs).to.have.property("shareEscrow");

      // All should be valid PublicKeys
      expect(addrs.vault).to.be.instanceOf(PublicKey);
      expect(addrs.sharesMint).to.be.instanceOf(PublicKey);
      expect(addrs.assetVault).to.be.instanceOf(PublicKey);
      expect(addrs.shareEscrow).to.be.instanceOf(PublicKey);
    });

    it("addresses match individual derivation functions", () => {
      const addrs = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);
      const [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
      const [sharesMint] = getAsyncSharesMintAddress(PROGRAM_ID, vault);
      const [assetVault] = getAssetVaultAddress(PROGRAM_ID, vault);
      const [shareEscrow] = getShareEscrowAddress(PROGRAM_ID, vault);

      expect(addrs.vault.equals(vault)).to.be.true;
      expect(addrs.sharesMint.equals(sharesMint)).to.be.true;
      expect(addrs.assetVault.equals(assetVault)).to.be.true;
      expect(addrs.shareEscrow.equals(shareEscrow)).to.be.true;
    });

    it("different vault IDs produce completely different address sets", () => {
      const a1 = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);
      const a2 = deriveAsyncVaultAddresses(PROGRAM_ID, ASSET_MINT, 2);

      expect(a1.vault.equals(a2.vault)).to.be.false;
      expect(a1.sharesMint.equals(a2.sharesMint)).to.be.false;
      expect(a1.assetVault.equals(a2.assetVault)).to.be.false;
      expect(a1.shareEscrow.equals(a2.shareEscrow)).to.be.false;
    });
  });

  // ==========================================================================
  // Per-User PDA Derivation (CLI context)
  // ==========================================================================

  describe("Per-User PDA Consistency", () => {
    let vault: PublicKey;

    before(() => {
      [vault] = getAsyncVaultAddress(PROGRAM_ID, ASSET_MINT, 1);
    });

    it("deposit + redeem requests for same user are different PDAs", () => {
      const [dep] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);
      const [red] = getRedeemRequestAddress(PROGRAM_ID, vault, OWNER);
      expect(dep.equals(red)).to.be.false;
    });

    it("claimable escrow and claimable tokens are different PDAs", () => {
      const [esc] = getClaimableEscrowAddress(PROGRAM_ID, vault, OWNER);
      const [tok] = getClaimableTokensAddress(PROGRAM_ID, vault, OWNER);
      expect(esc.equals(tok)).to.be.false;
    });

    it("all per-user PDAs are unique for the same user+vault", () => {
      const [dep] = getDepositRequestAddress(PROGRAM_ID, vault, OWNER);
      const [red] = getRedeemRequestAddress(PROGRAM_ID, vault, OWNER);
      const [esc] = getClaimableEscrowAddress(PROGRAM_ID, vault, OWNER);
      const [tok] = getClaimableTokensAddress(PROGRAM_ID, vault, OWNER);
      const [opr] = getOperatorApprovalAddress(
        PROGRAM_ID,
        vault,
        OWNER,
        OPERATOR,
      );

      const keys = [dep, red, esc, tok, opr].map((k) => k.toBase58());
      const unique = new Set(keys);
      expect(unique.size).to.equal(5);
    });
  });
});
