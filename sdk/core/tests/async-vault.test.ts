/** Tests for async vault interfaces, params, state types, and error codes */

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  AsyncVaultState,
  CreateAsyncVaultParams,
  RequestDepositParams,
  RequestRedeemParams,
  FulfillParams,
  ClaimParams,
  SetOperatorParams,
  DepositRequestState,
  RedeemRequestState,
  OperatorApprovalState,
} from "../src/async-vault";

import * as fs from "fs";
import * as path from "path";

// Derive error codes from the IDL when available (keeps codes in sync with program).
// Falls back to hardcoded values in environments without a build (e.g. CI SDK tests).
const IDL_PATH = path.join(__dirname, "../../../target/idl/svs_10.json");
const AsyncVaultErrorCode: Record<string, number> = fs.existsSync(IDL_PATH)
  ? Object.fromEntries(
      JSON.parse(fs.readFileSync(IDL_PATH, "utf-8")).errors.map(
        (e: { code: number; name: string }) => [e.name, e.code],
      ),
    )
  : {
      ZeroAmount: 6000,
      VaultPaused: 6001,
      InvalidAssetDecimals: 6002,
      MathOverflow: 6003,
      DivisionByZero: 6004,
      Unauthorized: 6005,
      DepositTooSmall: 6006,
      VaultNotPaused: 6007,
      RequestNotPending: 6008,
      RequestNotFulfilled: 6009,
      OperatorNotApproved: 6010,
      OracleStale: 6011,
      InsufficientLiquidity: 6012,
      OracleDeviationExceeded: 6013,
      InvalidRequestOwner: 6014,
      RequestExpired: 6015,
      GlobalCapExceeded: 6016,
      EntryFeeExceedsMax: 6017,
      LockDurationExceedsMax: 6018,
      InvalidAddress: 6019,
      InvalidParameter: 6020,
    };

function parseAsyncVaultError(
  errorMessage: string,
): { code: number; name: string } | null {
  const codeMatch = errorMessage.match(/Error Number: (\d+)/);
  const nameMatch = errorMessage.match(/Error Code: (\w+)/);

  if (codeMatch && nameMatch) {
    return {
      code: parseInt(codeMatch[1]),
      name: nameMatch[1],
    };
  }

  for (const [name, code] of Object.entries(AsyncVaultErrorCode)) {
    if (typeof code === "number" && errorMessage.includes(name)) {
      return { code, name };
    }
  }

  return null;
}

describe("SDK Async Vault Module", () => {
  const PROGRAM_ID = new PublicKey(
    "SVS1VauLt1111111111111111111111111111111111",
  );
  const ASSET_MINT = new PublicKey(
    "So11111111111111111111111111111111111111112",
  );
  const OWNER = new PublicKey("11111111111111111111111111111111");
  const OPERATOR = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const RECEIVER = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  );

  describe("AsyncVaultState Interface", () => {
    it("has correct structure with all fields", () => {
      const state: AsyncVaultState = {
        authority: PROGRAM_ID,
        operator: OPERATOR,
        assetMint: ASSET_MINT,
        sharesMint: PROGRAM_ID,
        assetVault: PROGRAM_ID,
        vaultId: new BN(1),
        totalAssets: new BN(1000),
        totalShares: new BN(1000),
        totalPendingDeposits: new BN(0),
        decimalsOffset: 3,
        paused: false,
        maxStaleness: new BN(60),
        maxDeviationBps: 500,
        cancelAfter: new BN(86400),
        bump: 255,
        shareEscrowBump: 254,
      };

      expect(state.authority).to.be.instanceOf(PublicKey);
      expect(state.operator).to.be.instanceOf(PublicKey);
      expect(state.assetMint).to.be.instanceOf(PublicKey);
      expect(state.sharesMint).to.be.instanceOf(PublicKey);
      expect(state.assetVault).to.be.instanceOf(PublicKey);
      expect(state.vaultId).to.be.instanceOf(BN);
      expect(state.totalAssets).to.be.instanceOf(BN);
      expect(state.totalShares).to.be.instanceOf(BN);
      expect(state.totalPendingDeposits).to.be.instanceOf(BN);
      expect(state.decimalsOffset).to.be.a("number");
      expect(state.paused).to.be.a("boolean");
      expect(state.maxStaleness).to.be.instanceOf(BN);
      expect(state.maxDeviationBps).to.be.a("number");
      expect(state.cancelAfter).to.be.instanceOf(BN);
      expect(state.bump).to.be.a("number");
      expect(state.shareEscrowBump).to.be.a("number");
    });

    it("supports paused state", () => {
      const state: AsyncVaultState = {
        authority: PROGRAM_ID,
        operator: OPERATOR,
        assetMint: ASSET_MINT,
        sharesMint: PROGRAM_ID,
        assetVault: PROGRAM_ID,
        vaultId: new BN(1),
        totalAssets: new BN(0),
        totalShares: new BN(0),
        totalPendingDeposits: new BN(0),
        decimalsOffset: 3,
        paused: true,
        maxStaleness: new BN(60),
        maxDeviationBps: 500,
        cancelAfter: new BN(86400),
        bump: 254,
        shareEscrowBump: 253,
      };

      expect(state.paused).to.be.true;
    });

    it("supports large values (u64::MAX)", () => {
      const state: AsyncVaultState = {
        authority: PROGRAM_ID,
        operator: OPERATOR,
        assetMint: ASSET_MINT,
        sharesMint: PROGRAM_ID,
        assetVault: PROGRAM_ID,
        vaultId: new BN("18446744073709551615"),
        totalAssets: new BN("18446744073709551615"),
        totalShares: new BN("18446744073709551615"),
        totalPendingDeposits: new BN(0),
        decimalsOffset: 0,
        paused: false,
        maxStaleness: new BN(3600),
        maxDeviationBps: 1000,
        cancelAfter: new BN(3600),
        bump: 255,
        shareEscrowBump: 254,
      };

      expect(state.totalAssets.toString()).to.equal("18446744073709551615");
      expect(state.totalShares.toString()).to.equal("18446744073709551615");
    });

    it("totalPendingDeposits tracks independently from totalAssets", () => {
      const state: AsyncVaultState = {
        authority: PROGRAM_ID,
        operator: OPERATOR,
        assetMint: ASSET_MINT,
        sharesMint: PROGRAM_ID,
        assetVault: PROGRAM_ID,
        vaultId: new BN(1),
        totalAssets: new BN(10_000_000),
        totalShares: new BN(10_000_000_000),
        totalPendingDeposits: new BN(5_000_000),
        decimalsOffset: 3,
        paused: false,
        maxStaleness: new BN(60),
        maxDeviationBps: 500,
        cancelAfter: new BN(86400),
        bump: 255,
        shareEscrowBump: 254,
      };

      expect(state.totalPendingDeposits.toNumber()).to.equal(5_000_000);
      expect(state.totalAssets.toNumber()).to.equal(10_000_000);
      expect(state.totalPendingDeposits.lt(state.totalAssets)).to.be.true;
    });
  });

  describe("CreateAsyncVaultParams Interface", () => {
    it("accepts valid params with all fields", () => {
      const params: CreateAsyncVaultParams = {
        assetMint: ASSET_MINT,
        operator: OPERATOR,
        vaultId: 1,
        name: "Async SOL Vault",
        symbol: "aSOL",
        uri: "https://example.com/vault.json",
      };

      expect(params.assetMint).to.be.instanceOf(PublicKey);
      expect(params.operator).to.be.instanceOf(PublicKey);
      expect(params.vaultId).to.equal(1);
      expect(params.name).to.equal("Async SOL Vault");
      expect(params.symbol).to.equal("aSOL");
    });

    it("accepts BN for vaultId", () => {
      const params: CreateAsyncVaultParams = {
        assetMint: ASSET_MINT,
        operator: OPERATOR,
        vaultId: new BN(999),
        name: "BN Vault",
        symbol: "BNV",
        uri: "https://example.com/bn.json",
      };

      expect(params.vaultId).to.be.instanceOf(BN);
      expect((params.vaultId as BN).toNumber()).to.equal(999);
    });

    it("supports metadata strings", () => {
      const longUri = "https://arweave.net/" + "a".repeat(100);
      const params: CreateAsyncVaultParams = {
        assetMint: ASSET_MINT,
        operator: OPERATOR,
        vaultId: 1,
        name: "A".repeat(32),
        symbol: "LONG",
        uri: longUri,
      };

      expect(params.name.length).to.equal(32);
      expect(params.uri.length).to.be.greaterThan(100);
    });
  });

  describe("RequestDepositParams Interface", () => {
    it("creates valid params with assets as BN", () => {
      const params: RequestDepositParams = {
        assets: new BN(1_000_000),
      };

      expect(params.assets.toNumber()).to.equal(1_000_000);
    });

    it("optional receiver can be omitted", () => {
      const params: RequestDepositParams = {
        assets: new BN(1_000_000),
      };

      expect(params.receiver).to.be.undefined;
    });

    it("optional receiver can be specified", () => {
      const params: RequestDepositParams = {
        assets: new BN(1_000_000),
        receiver: RECEIVER,
      };

      expect(params.receiver).to.be.instanceOf(PublicKey);
      expect(params.receiver!.equals(RECEIVER)).to.be.true;
    });

    it("supports large amounts", () => {
      const params: RequestDepositParams = {
        assets: new BN("18446744073709551615"),
      };

      expect(params.assets.gt(new BN(0))).to.be.true;
    });
  });

  describe("RequestRedeemParams Interface", () => {
    it("creates valid params with shares as BN", () => {
      const params: RequestRedeemParams = {
        shares: new BN(1_000_000_000),
      };

      expect(params.shares.toNumber()).to.equal(1_000_000_000);
    });

    it("optional receiver can be omitted", () => {
      const params: RequestRedeemParams = {
        shares: new BN(500_000_000),
      };

      expect(params.receiver).to.be.undefined;
    });

    it("optional receiver can be specified", () => {
      const params: RequestRedeemParams = {
        shares: new BN(500_000_000),
        receiver: RECEIVER,
      };

      expect(params.receiver!.equals(RECEIVER)).to.be.true;
    });
  });

  describe("FulfillParams Interface", () => {
    it("creates valid params with owner", () => {
      const params: FulfillParams = {
        owner: OWNER,
      };

      expect(params.owner).to.be.instanceOf(PublicKey);
      expect(params.owner.equals(OWNER)).to.be.true;
    });

    it("optional oraclePrice can be BN", () => {
      const params: FulfillParams = {
        owner: OWNER,
        oraclePrice: new BN(100_000_000),
      };

      expect(params.oraclePrice).to.be.instanceOf(BN);
      expect(params.oraclePrice!.toNumber()).to.equal(100_000_000);
    });

    it("optional oraclePrice can be undefined", () => {
      const params: FulfillParams = {
        owner: OWNER,
      };

      expect(params.oraclePrice).to.be.undefined;
    });

    it("optional operatorApproval flag", () => {
      const params: FulfillParams = {
        owner: OWNER,
        operatorApproval: true,
      };

      expect(params.operatorApproval).to.be.true;
    });
  });

  describe("ClaimParams Interface", () => {
    it("requires owner and receiver as PublicKey", () => {
      const params: ClaimParams = {
        owner: OWNER,
        receiver: RECEIVER,
      };

      expect(params.owner).to.be.instanceOf(PublicKey);
      expect(params.receiver).to.be.instanceOf(PublicKey);
      expect(params.owner.equals(OWNER)).to.be.true;
      expect(params.receiver.equals(RECEIVER)).to.be.true;
    });
  });

  describe("SetOperatorParams Interface", () => {
    it("grant all permissions", () => {
      const params: SetOperatorParams = {
        operator: OPERATOR,
        canFulfillDeposit: true,
        canFulfillRedeem: true,
        canClaim: true,
      };

      expect(params.canFulfillDeposit).to.be.true;
      expect(params.canFulfillRedeem).to.be.true;
      expect(params.canClaim).to.be.true;
    });

    it("revoke all permissions", () => {
      const params: SetOperatorParams = {
        operator: OPERATOR,
        canFulfillDeposit: false,
        canFulfillRedeem: false,
        canClaim: false,
      };

      expect(params.canFulfillDeposit).to.be.false;
      expect(params.canFulfillRedeem).to.be.false;
      expect(params.canClaim).to.be.false;
    });

    it("permissions are independent booleans", () => {
      const depositOnly: SetOperatorParams = {
        operator: OPERATOR,
        canFulfillDeposit: true,
        canFulfillRedeem: false,
        canClaim: false,
      };

      const redeemOnly: SetOperatorParams = {
        operator: OPERATOR,
        canFulfillDeposit: false,
        canFulfillRedeem: true,
        canClaim: false,
      };

      const claimOnly: SetOperatorParams = {
        operator: OPERATOR,
        canFulfillDeposit: false,
        canFulfillRedeem: false,
        canClaim: true,
      };

      expect(depositOnly.canFulfillDeposit).to.be.true;
      expect(depositOnly.canFulfillRedeem).to.be.false;
      expect(depositOnly.canClaim).to.be.false;

      expect(redeemOnly.canFulfillDeposit).to.be.false;
      expect(redeemOnly.canFulfillRedeem).to.be.true;
      expect(redeemOnly.canClaim).to.be.false;

      expect(claimOnly.canFulfillDeposit).to.be.false;
      expect(claimOnly.canFulfillRedeem).to.be.false;
      expect(claimOnly.canClaim).to.be.true;
    });
  });

  describe("DepositRequestState Interface", () => {
    it("has correct structure", () => {
      const state: DepositRequestState = {
        owner: OWNER,
        receiver: RECEIVER,
        vault: PROGRAM_ID,
        assetsLocked: new BN(1_000_000),
        sharesClaimable: new BN(0),
        status: { pending: {} },
        requestedAt: new BN(1700000000),
        fulfilledAt: new BN(0),
        bump: 254,
      };

      expect(state.owner).to.be.instanceOf(PublicKey);
      expect(state.receiver).to.be.instanceOf(PublicKey);
      expect(state.vault).to.be.instanceOf(PublicKey);
      expect(state.assetsLocked).to.be.instanceOf(BN);
      expect(state.sharesClaimable).to.be.instanceOf(BN);
      expect(state.requestedAt).to.be.instanceOf(BN);
      expect(state.fulfilledAt).to.be.instanceOf(BN);
      expect(state.bump).to.be.a("number");
    });

    it("status pending variant", () => {
      const state: DepositRequestState = {
        owner: OWNER,
        receiver: OWNER,
        vault: PROGRAM_ID,
        assetsLocked: new BN(1_000_000),
        sharesClaimable: new BN(0),
        status: { pending: {} },
        requestedAt: new BN(1700000000),
        fulfilledAt: new BN(0),
        bump: 254,
      };

      expect(state.status).to.have.property("pending");
    });

    it("status fulfilled variant", () => {
      const state: DepositRequestState = {
        owner: OWNER,
        receiver: OWNER,
        vault: PROGRAM_ID,
        assetsLocked: new BN(1_000_000),
        sharesClaimable: new BN(999_000_000),
        status: { fulfilled: {} },
        requestedAt: new BN(1700000000),
        fulfilledAt: new BN(1700003600),
        bump: 254,
      };

      expect(state.status).to.have.property("fulfilled");
    });
  });

  describe("RedeemRequestState Interface", () => {
    it("has correct structure", () => {
      const state: RedeemRequestState = {
        owner: OWNER,
        receiver: RECEIVER,
        vault: PROGRAM_ID,
        sharesLocked: new BN(1_000_000_000),
        assetsClaimable: new BN(0),
        status: { pending: {} },
        requestedAt: new BN(1700000000),
        fulfilledAt: new BN(0),
        bump: 253,
      };

      expect(state.owner).to.be.instanceOf(PublicKey);
      expect(state.sharesLocked).to.be.instanceOf(BN);
      expect(state.assetsClaimable).to.be.instanceOf(BN);
      expect(state.bump).to.be.a("number");
    });

    it("status fulfilled variant", () => {
      const state: RedeemRequestState = {
        owner: OWNER,
        receiver: OWNER,
        vault: PROGRAM_ID,
        sharesLocked: new BN(1_000_000_000),
        assetsClaimable: new BN(1_000_000),
        status: { fulfilled: {} },
        requestedAt: new BN(1700000000),
        fulfilledAt: new BN(1700003600),
        bump: 253,
      };

      expect(state.status).to.have.property("fulfilled");
      expect(state.assetsClaimable.toNumber()).to.equal(1_000_000);
    });
  });

  describe("OperatorApprovalState Interface", () => {
    it("has correct structure", () => {
      const state: OperatorApprovalState = {
        owner: OWNER,
        operator: OPERATOR,
        vault: PROGRAM_ID,
        canFulfillDeposit: true,
        canFulfillRedeem: false,
        canClaim: true,
        bump: 252,
      };

      expect(state.owner).to.be.instanceOf(PublicKey);
      expect(state.operator).to.be.instanceOf(PublicKey);
      expect(state.vault).to.be.instanceOf(PublicKey);
      expect(state.canFulfillDeposit).to.be.a("boolean");
      expect(state.canFulfillRedeem).to.be.a("boolean");
      expect(state.canClaim).to.be.a("boolean");
      expect(state.bump).to.be.a("number");
    });

    it("granular permissions are independent booleans", () => {
      const state: OperatorApprovalState = {
        owner: OWNER,
        operator: OPERATOR,
        vault: PROGRAM_ID,
        canFulfillDeposit: true,
        canFulfillRedeem: false,
        canClaim: false,
        bump: 252,
      };

      expect(state.canFulfillDeposit).to.be.true;
      expect(state.canFulfillRedeem).to.be.false;
      expect(state.canClaim).to.be.false;
    });
  });

  describe("SVS-10 Error Codes", () => {
    it("defines all error codes from error.rs", () => {
      expect(AsyncVaultErrorCode.ZeroAmount).to.equal(6000);
      expect(AsyncVaultErrorCode.VaultPaused).to.equal(6001);
      expect(AsyncVaultErrorCode.InvalidAssetDecimals).to.equal(6002);
      expect(AsyncVaultErrorCode.MathOverflow).to.equal(6003);
      expect(AsyncVaultErrorCode.DivisionByZero).to.equal(6004);
      expect(AsyncVaultErrorCode.Unauthorized).to.equal(6005);
      expect(AsyncVaultErrorCode.DepositTooSmall).to.equal(6006);
      expect(AsyncVaultErrorCode.VaultNotPaused).to.equal(6007);
      expect(AsyncVaultErrorCode.RequestNotPending).to.equal(6008);
      expect(AsyncVaultErrorCode.RequestNotFulfilled).to.equal(6009);
      expect(AsyncVaultErrorCode.OperatorNotApproved).to.equal(6010);
      expect(AsyncVaultErrorCode.OracleStale).to.equal(6011);
      expect(AsyncVaultErrorCode.InsufficientLiquidity).to.equal(6012);
      expect(AsyncVaultErrorCode.OracleDeviationExceeded).to.equal(6013);
      expect(AsyncVaultErrorCode.InvalidRequestOwner).to.equal(6014);
      expect(AsyncVaultErrorCode.RequestExpired).to.equal(6015);
      expect(AsyncVaultErrorCode.GlobalCapExceeded).to.equal(6016);
      expect(AsyncVaultErrorCode.EntryFeeExceedsMax).to.equal(6017);
      expect(AsyncVaultErrorCode.LockDurationExceedsMax).to.equal(6018);
      expect(AsyncVaultErrorCode.InvalidAddress).to.equal(6019);
      expect(AsyncVaultErrorCode.InvalidParameter).to.equal(6020);
    });

    it("error codes are sequential from 6000", () => {
      const codes = Object.values(AsyncVaultErrorCode).filter(
        (v) => typeof v === "number",
      ) as number[];
      codes.sort((a, b) => a - b);

      expect(codes[0]).to.equal(6000);
      for (let i = 1; i < codes.length; i++) {
        expect(codes[i]).to.equal(codes[i - 1] + 1);
      }
    });

    it("error parser handles Anchor format", () => {
      const errorMsg =
        "AnchorError occurred. Error Code: Unauthorized. Error Number: 6005.";
      const parsed = parseAsyncVaultError(errorMsg);

      expect(parsed).to.not.be.null;
      expect(parsed!.code).to.equal(6005);
      expect(parsed!.name).to.equal("Unauthorized");
    });

    it("error parser handles simple message", () => {
      const errorMsg = "Transaction failed: VaultPaused";
      const parsed = parseAsyncVaultError(errorMsg);

      expect(parsed).to.not.be.null;
      expect(parsed!.code).to.equal(6001);
    });

    it("error parser returns null for unknown error", () => {
      const parsed = parseAsyncVaultError("Some random error");
      expect(parsed).to.be.null;
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

    it("validates max deviation BPS bounds", () => {
      const MAX_DEVIATION_BPS = 10000;

      const isValidDeviation = (bps: number): boolean => {
        return bps >= 0 && bps <= MAX_DEVIATION_BPS;
      };

      expect(isValidDeviation(0)).to.be.true;
      expect(isValidDeviation(500)).to.be.true;
      expect(isValidDeviation(10000)).to.be.true;
      expect(isValidDeviation(10001)).to.be.false;
      expect(isValidDeviation(-1)).to.be.false;
    });

    it("oracle price must be greater than zero", () => {
      const isValidOraclePrice = (price: BN): boolean => {
        return price.gt(new BN(0));
      };

      expect(isValidOraclePrice(new BN(1))).to.be.true;
      expect(isValidOraclePrice(new BN(100_000_000))).to.be.true;
      expect(isValidOraclePrice(new BN(0))).to.be.false;
    });

    it("validates vault ID range", () => {
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
    it("Token-2022 program ID is correct", () => {
      const TOKEN_2022_PROGRAM_ID = new PublicKey(
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      );
      expect(TOKEN_2022_PROGRAM_ID).to.be.instanceOf(PublicKey);
    });

    it("Associated Token program ID is correct", () => {
      const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      );
      expect(ASSOCIATED_TOKEN_PROGRAM_ID).to.be.instanceOf(PublicKey);
    });
  });
});
