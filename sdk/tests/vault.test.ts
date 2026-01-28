import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  VaultState,
  CreateVaultParams,
  DepositParams,
  MintParams,
  WithdrawParams,
  RedeemParams,
} from "../src/vault";
import { deriveVaultAddresses } from "../src/pda";

describe("SDK Vault Module", () => {
  const PROGRAM_ID = new PublicKey(
    "SVS1VauLt1111111111111111111111111111111111",
  );
  const ASSET_MINT = new PublicKey(
    "So11111111111111111111111111111111111111112",
  );
  const USDC_MINT = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );

  describe("VaultState Interface", () => {
    it("has correct structure", () => {
      const state: VaultState = {
        authority: PROGRAM_ID,
        assetMint: ASSET_MINT,
        sharesMint: PROGRAM_ID,
        assetVault: PROGRAM_ID,
        totalAssets: new BN(1000),
        decimalsOffset: 3,
        bump: 255,
        paused: false,
        vaultId: new BN(1),
      };

      expect(state.authority).to.be.instanceOf(PublicKey);
      expect(state.assetMint).to.be.instanceOf(PublicKey);
      expect(state.sharesMint).to.be.instanceOf(PublicKey);
      expect(state.assetVault).to.be.instanceOf(PublicKey);
      expect(state.totalAssets).to.be.instanceOf(BN);
      expect(state.decimalsOffset).to.be.a("number");
      expect(state.bump).to.be.a("number");
      expect(state.paused).to.be.a("boolean");
      expect(state.vaultId).to.be.instanceOf(BN);
    });

    it("supports paused state", () => {
      const pausedState: VaultState = {
        authority: PROGRAM_ID,
        assetMint: ASSET_MINT,
        sharesMint: PROGRAM_ID,
        assetVault: PROGRAM_ID,
        totalAssets: new BN(0),
        decimalsOffset: 3,
        bump: 254,
        paused: true,
        vaultId: new BN(1),
      };

      expect(pausedState.paused).to.be.true;
    });

    it("supports large totalAssets values", () => {
      const state: VaultState = {
        authority: PROGRAM_ID,
        assetMint: ASSET_MINT,
        sharesMint: PROGRAM_ID,
        assetVault: PROGRAM_ID,
        totalAssets: new BN("18446744073709551615"), // u64::MAX
        decimalsOffset: 0,
        bump: 255,
        paused: false,
        vaultId: new BN("18446744073709551615"),
      };

      expect(state.totalAssets.toString()).to.equal("18446744073709551615");
      expect(state.vaultId.toString()).to.equal("18446744073709551615");
    });
  });

  describe("CreateVaultParams Interface", () => {
    it("accepts number vault_id", () => {
      const params: CreateVaultParams = {
        assetMint: ASSET_MINT,
        vaultId: 1,
        name: "Test Vault",
        symbol: "tVAULT",
        uri: "https://example.com/vault.json",
      };

      expect(params.vaultId).to.equal(1);
      expect(params.name).to.equal("Test Vault");
      expect(params.symbol).to.equal("tVAULT");
    });

    it("accepts BN vault_id", () => {
      const params: CreateVaultParams = {
        assetMint: USDC_MINT,
        vaultId: new BN(999),
        name: "USDC Vault",
        symbol: "uVAULT",
        uri: "https://example.com/usdc.json",
      };

      expect(params.vaultId).to.be.instanceOf(BN);
      expect((params.vaultId as BN).toNumber()).to.equal(999);
    });

    it("supports long metadata strings", () => {
      const longUri = "https://arweave.net/" + "a".repeat(100);
      const params: CreateVaultParams = {
        assetMint: ASSET_MINT,
        vaultId: 1,
        name: "A".repeat(32), // Max name length
        symbol: "LONG",
        uri: longUri,
      };

      expect(params.name.length).to.equal(32);
      expect(params.uri.length).to.be.greaterThan(100);
    });
  });

  describe("DepositParams Interface", () => {
    it("creates valid deposit params", () => {
      const params: DepositParams = {
        assets: new BN(1_000_000), // 1 USDC
        minSharesOut: new BN(999_000), // Accept up to 0.1% slippage
      };

      expect(params.assets.toNumber()).to.equal(1_000_000);
      expect(params.minSharesOut.toNumber()).to.equal(999_000);
    });

    it("supports zero slippage (minSharesOut = 0)", () => {
      const params: DepositParams = {
        assets: new BN(1_000_000),
        minSharesOut: new BN(0),
      };

      expect(params.minSharesOut.toNumber()).to.equal(0);
    });

    it("supports large deposit amounts", () => {
      const params: DepositParams = {
        assets: new BN("1000000000000000000"), // 10^18
        minSharesOut: new BN(0),
      };

      expect(params.assets.gt(new BN(0))).to.be.true;
    });
  });

  describe("MintParams Interface", () => {
    it("creates valid mint params", () => {
      const params: MintParams = {
        shares: new BN(1_000_000_000), // 1 share (9 decimals)
        maxAssetsIn: new BN(1_010_000), // Accept up to 1% extra cost
      };

      expect(params.shares.toNumber()).to.equal(1_000_000_000);
      expect(params.maxAssetsIn.toNumber()).to.equal(1_010_000);
    });

    it("supports max assets in = u64::MAX", () => {
      const params: MintParams = {
        shares: new BN(1000),
        maxAssetsIn: new BN("18446744073709551615"),
      };

      expect(params.maxAssetsIn.toString()).to.equal("18446744073709551615");
    });
  });

  describe("WithdrawParams Interface", () => {
    it("creates valid withdraw params", () => {
      const params: WithdrawParams = {
        assets: new BN(500_000), // Withdraw 0.5 USDC
        maxSharesIn: new BN(505_000_000), // Accept up to 1% extra shares burned
      };

      expect(params.assets.toNumber()).to.equal(500_000);
      expect(params.maxSharesIn.toNumber()).to.equal(505_000_000);
    });

    it("supports precise withdrawal", () => {
      const params: WithdrawParams = {
        assets: new BN(1), // Withdraw minimum
        maxSharesIn: new BN("18446744073709551615"), // Unlimited shares allowed
      };

      expect(params.assets.toNumber()).to.equal(1);
    });
  });

  describe("RedeemParams Interface", () => {
    it("creates valid redeem params", () => {
      const params: RedeemParams = {
        shares: new BN(1_000_000_000), // Redeem 1 share
        minAssetsOut: new BN(990_000), // Accept up to 1% slippage
      };

      expect(params.shares.toNumber()).to.equal(1_000_000_000);
      expect(params.minAssetsOut.toNumber()).to.equal(990_000);
    });

    it("supports full redeem with zero min", () => {
      const params: RedeemParams = {
        shares: new BN("18446744073709551615"), // Redeem all
        minAssetsOut: new BN(0),
      };

      expect(params.minAssetsOut.toNumber()).to.equal(0);
    });
  });

  describe("Address Derivation Integration", () => {
    it("derives consistent addresses for vault operations", () => {
      const vaultId = new BN(42);
      const addresses = deriveVaultAddresses(PROGRAM_ID, ASSET_MINT, vaultId);

      expect(addresses.vault).to.be.instanceOf(PublicKey);
      expect(addresses.sharesMint).to.be.instanceOf(PublicKey);
      expect(addresses.vaultBump).to.be.lessThanOrEqual(255);
      expect(addresses.sharesMintBump).to.be.lessThanOrEqual(255);
    });

    it("derives different addresses for different vaults", () => {
      const addresses1 = deriveVaultAddresses(PROGRAM_ID, ASSET_MINT, 1);
      const addresses2 = deriveVaultAddresses(PROGRAM_ID, ASSET_MINT, 2);
      const addresses3 = deriveVaultAddresses(PROGRAM_ID, USDC_MINT, 1);

      expect(addresses1.vault.equals(addresses2.vault)).to.be.false;
      expect(addresses1.vault.equals(addresses3.vault)).to.be.false;
      expect(addresses1.sharesMint.equals(addresses2.sharesMint)).to.be.false;
    });
  });

  describe("Slippage Calculation Helpers", () => {
    it("calculates 0.5% slippage for deposit", () => {
      const expectedShares = new BN(1_000_000_000);
      const slippageBps = 50; // 0.5% = 50 basis points
      const minSharesOut = expectedShares
        .mul(new BN(10000 - slippageBps))
        .div(new BN(10000));

      expect(minSharesOut.toNumber()).to.equal(995_000_000);
    });

    it("calculates 1% slippage for mint", () => {
      const expectedAssets = new BN(1_000_000);
      const slippageBps = 100; // 1% = 100 basis points
      const maxAssetsIn = expectedAssets
        .mul(new BN(10000 + slippageBps))
        .div(new BN(10000));

      expect(maxAssetsIn.toNumber()).to.equal(1_010_000);
    });

    it("calculates 2% slippage for withdraw", () => {
      const expectedShares = new BN(500_000_000);
      const slippageBps = 200; // 2% = 200 basis points
      const maxSharesIn = expectedShares
        .mul(new BN(10000 + slippageBps))
        .div(new BN(10000));

      expect(maxSharesIn.toNumber()).to.equal(510_000_000);
    });

    it("calculates 0.1% slippage for redeem", () => {
      const expectedAssets = new BN(1_000_000);
      const slippageBps = 10; // 0.1% = 10 basis points
      const minAssetsOut = expectedAssets
        .mul(new BN(10000 - slippageBps))
        .div(new BN(10000));

      expect(minAssetsOut.toNumber()).to.equal(999_000);
    });
  });

  describe("BN Arithmetic Edge Cases", () => {
    it("handles BN comparison correctly", () => {
      const a = new BN(100);
      const b = new BN(200);

      expect(a.lt(b)).to.be.true;
      expect(b.gt(a)).to.be.true;
      expect(a.eq(new BN(100))).to.be.true;
      expect(a.lte(a)).to.be.true;
      expect(a.gte(a)).to.be.true;
    });

    it("handles BN arithmetic with large numbers", () => {
      const large = new BN("9999999999999999999");
      const small = new BN(1);

      expect(large.add(small).toString()).to.equal("10000000000000000000");
      expect(large.sub(small).toString()).to.equal("9999999999999999998");
    });

    it("handles BN division rounding", () => {
      const numerator = new BN(10);
      const denominator = new BN(3);

      // BN division floors by default
      const result = numerator.div(denominator);
      expect(result.toNumber()).to.equal(3); // Floor(10/3) = 3

      // Calculate ceiling manually
      const ceiling = numerator
        .add(denominator.sub(new BN(1)))
        .div(denominator);
      expect(ceiling.toNumber()).to.equal(4); // Ceil(10/3) = 4
    });

    it("handles BN multiplication overflow safely", () => {
      const a = new BN("18446744073709551615"); // u64::MAX
      const b = new BN(2);

      // BN handles overflow correctly (becomes larger than u64)
      const product = a.mul(b);
      expect(product.gt(a)).to.be.true;
      expect(product.toString()).to.equal("36893488147419103230");
    });
  });

  describe("Parameter Validation Helpers", () => {
    it("validates minimum deposit amount", () => {
      const MIN_DEPOSIT = 1000;

      const isValidDeposit = (amount: BN): boolean => {
        return amount.gte(new BN(MIN_DEPOSIT));
      };

      expect(isValidDeposit(new BN(1000))).to.be.true;
      expect(isValidDeposit(new BN(1001))).to.be.true;
      expect(isValidDeposit(new BN(999))).to.be.false;
      expect(isValidDeposit(new BN(0))).to.be.false;
    });

    it("validates slippage bounds", () => {
      const MAX_SLIPPAGE_BPS = 1000; // 10% max slippage

      const isValidSlippage = (bps: number): boolean => {
        return bps >= 0 && bps <= MAX_SLIPPAGE_BPS;
      };

      expect(isValidSlippage(0)).to.be.true;
      expect(isValidSlippage(50)).to.be.true;
      expect(isValidSlippage(1000)).to.be.true;
      expect(isValidSlippage(1001)).to.be.false;
      expect(isValidSlippage(-1)).to.be.false;
    });

    it("validates vault_id range", () => {
      const isValidVaultId = (id: BN | number): boolean => {
        const bnId = typeof id === "number" ? new BN(id) : id;
        return bnId.gte(new BN(0)) && bnId.lte(new BN("18446744073709551615"));
      };

      expect(isValidVaultId(0)).to.be.true;
      expect(isValidVaultId(1)).to.be.true;
      expect(isValidVaultId(new BN("18446744073709551615"))).to.be.true;
      expect(isValidVaultId(-1)).to.be.false;
    });
  });

  describe("Token Program Constants", () => {
    it("uses correct Token Program ID", () => {
      const TOKEN_PROGRAM_ID = new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      );
      expect(TOKEN_PROGRAM_ID).to.be.instanceOf(PublicKey);
    });

    it("uses correct Token-2022 Program ID", () => {
      const TOKEN_2022_PROGRAM_ID = new PublicKey(
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      );
      expect(TOKEN_2022_PROGRAM_ID).to.be.instanceOf(PublicKey);
    });

    it("uses correct Associated Token Program ID", () => {
      const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      );
      expect(ASSOCIATED_TOKEN_PROGRAM_ID).to.be.instanceOf(PublicKey);
    });
  });
});
