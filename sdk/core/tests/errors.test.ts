import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";

// Error codes matching the program's error.rs
const VaultErrorCode = {
  Unauthorized: 6000,
  VaultPaused: 6001,
  SlippageExceeded: 6002,
  ZeroShares: 6003,
  ZeroAssets: 6004,
  InsufficientShares: 6005,
  InsufficientAssets: 6006,
  MathOverflow: 6007,
  DepositTooSmall: 6008,
} as const;

// Error message parser helper
function parseAnchorError(
  errorMessage: string,
): { code: number; name: string } | null {
  // Anchor error format: "Error Code: ErrorName. Error Number: XXXX."
  const codeMatch = errorMessage.match(/Error Number: (\d+)/);
  const nameMatch = errorMessage.match(/Error Code: (\w+)/);

  if (codeMatch && nameMatch) {
    return {
      code: parseInt(codeMatch[1]),
      name: nameMatch[1],
    };
  }

  // Alternative format: just the error name in the message
  for (const [name, code] of Object.entries(VaultErrorCode)) {
    if (typeof code === "number" && errorMessage.includes(name)) {
      return { code, name };
    }
  }

  return null;
}

describe("SDK Error Handling", () => {
  describe("Error Code Constants", () => {
    it("defines all expected error codes", () => {
      expect(VaultErrorCode.Unauthorized).to.equal(6000);
      expect(VaultErrorCode.VaultPaused).to.equal(6001);
      expect(VaultErrorCode.SlippageExceeded).to.equal(6002);
      expect(VaultErrorCode.ZeroShares).to.equal(6003);
      expect(VaultErrorCode.ZeroAssets).to.equal(6004);
      expect(VaultErrorCode.InsufficientShares).to.equal(6005);
      expect(VaultErrorCode.InsufficientAssets).to.equal(6006);
      expect(VaultErrorCode.MathOverflow).to.equal(6007);
      expect(VaultErrorCode.DepositTooSmall).to.equal(6008);
    });

    it("error codes are sequential from 6000", () => {
      const codes = Object.values(VaultErrorCode).filter(
        (v) => typeof v === "number",
      ) as number[];
      codes.sort((a, b) => a - b);

      expect(codes[0]).to.equal(6000);
      for (let i = 1; i < codes.length; i++) {
        expect(codes[i]).to.equal(codes[i - 1] + 1);
      }
    });
  });

  describe("Error Message Parsing", () => {
    it("parses Unauthorized error", () => {
      const errorMsg =
        "AnchorError caused by account: authority. Error Code: Unauthorized. Error Number: 6000.";
      const parsed = parseAnchorError(errorMsg);

      expect(parsed).to.not.be.null;
      expect(parsed!.code).to.equal(6000);
      expect(parsed!.name).to.equal("Unauthorized");
    });

    it("parses VaultPaused error", () => {
      const errorMsg =
        "AnchorError occurred. Error Code: VaultPaused. Error Number: 6001.";
      const parsed = parseAnchorError(errorMsg);

      expect(parsed).to.not.be.null;
      expect(parsed!.code).to.equal(6001);
      expect(parsed!.name).to.equal("VaultPaused");
    });

    it("parses SlippageExceeded error", () => {
      const errorMsg = "Error Code: SlippageExceeded. Error Number: 6002.";
      const parsed = parseAnchorError(errorMsg);

      expect(parsed).to.not.be.null;
      expect(parsed!.code).to.equal(6002);
    });

    it("parses error from simple message", () => {
      const errorMsg = "Transaction failed: ZeroShares";
      const parsed = parseAnchorError(errorMsg);

      expect(parsed).to.not.be.null;
      expect(parsed!.code).to.equal(6003);
    });

    it("returns null for unknown error", () => {
      const errorMsg = "Some random error message";
      const parsed = parseAnchorError(errorMsg);

      expect(parsed).to.be.null;
    });
  });

  describe("Error Type Guards", () => {
    const isVaultError = (
      error: unknown,
    ): error is { code: number; message: string } => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        "message" in error &&
        typeof (error as { code: number }).code === "number"
      );
    };

    const isSlippageError = (error: unknown): boolean => {
      if (!isVaultError(error)) return false;
      return error.code === VaultErrorCode.SlippageExceeded;
    };

    const isAuthError = (error: unknown): boolean => {
      if (!isVaultError(error)) return false;
      return error.code === VaultErrorCode.Unauthorized;
    };

    it("identifies vault errors", () => {
      const vaultError = { code: 6001, message: "VaultPaused" };
      const nonVaultError = { message: "Some error" };

      expect(isVaultError(vaultError)).to.be.true;
      expect(isVaultError(nonVaultError)).to.be.false;
      expect(isVaultError(null)).to.be.false;
      expect(isVaultError("string")).to.be.false;
    });

    it("identifies slippage errors", () => {
      const slippageError = { code: 6002, message: "SlippageExceeded" };
      const otherError = { code: 6001, message: "VaultPaused" };

      expect(isSlippageError(slippageError)).to.be.true;
      expect(isSlippageError(otherError)).to.be.false;
    });

    it("identifies auth errors", () => {
      const authError = { code: 6000, message: "Unauthorized" };
      const otherError = { code: 6001, message: "VaultPaused" };

      expect(isAuthError(authError)).to.be.true;
      expect(isAuthError(otherError)).to.be.false;
    });
  });

  describe("Slippage Validation", () => {
    interface SlippageCheckResult {
      isValid: boolean;
      error?: string;
    }

    const checkDepositSlippage = (
      expectedShares: BN,
      minSharesOut: BN,
    ): SlippageCheckResult => {
      if (expectedShares.lt(minSharesOut)) {
        return {
          isValid: false,
          error: `Slippage exceeded: expected ${expectedShares.toString()} shares but minimum is ${minSharesOut.toString()}`,
        };
      }
      return { isValid: true };
    };

    const checkMintSlippage = (
      requiredAssets: BN,
      maxAssetsIn: BN,
    ): SlippageCheckResult => {
      if (requiredAssets.gt(maxAssetsIn)) {
        return {
          isValid: false,
          error: `Slippage exceeded: required ${requiredAssets.toString()} assets but maximum is ${maxAssetsIn.toString()}`,
        };
      }
      return { isValid: true };
    };

    it("validates deposit slippage - pass", () => {
      const result = checkDepositSlippage(new BN(1000), new BN(990));
      expect(result.isValid).to.be.true;
      expect(result.error).to.be.undefined;
    });

    it("validates deposit slippage - fail", () => {
      const result = checkDepositSlippage(new BN(990), new BN(1000));
      expect(result.isValid).to.be.false;
      expect(result.error).to.include("Slippage exceeded");
    });

    it("validates deposit slippage - exact match", () => {
      const result = checkDepositSlippage(new BN(1000), new BN(1000));
      expect(result.isValid).to.be.true;
    });

    it("validates mint slippage - pass", () => {
      const result = checkMintSlippage(new BN(1000), new BN(1010));
      expect(result.isValid).to.be.true;
    });

    it("validates mint slippage - fail", () => {
      const result = checkMintSlippage(new BN(1010), new BN(1000));
      expect(result.isValid).to.be.false;
      expect(result.error).to.include("Slippage exceeded");
    });

    it("validates mint slippage - exact match", () => {
      const result = checkMintSlippage(new BN(1000), new BN(1000));
      expect(result.isValid).to.be.true;
    });
  });

  describe("Amount Validation", () => {
    const MIN_DEPOSIT = 1000;

    const validateDepositAmount = (
      amount: BN,
    ): { valid: boolean; error?: string } => {
      if (amount.isZero()) {
        return {
          valid: false,
          error: "ZeroAssets: deposit amount cannot be zero",
        };
      }
      if (amount.lt(new BN(MIN_DEPOSIT))) {
        return {
          valid: false,
          error: `DepositTooSmall: minimum deposit is ${MIN_DEPOSIT}`,
        };
      }
      return { valid: true };
    };

    const validateSharesAmount = (
      shares: BN,
    ): { valid: boolean; error?: string } => {
      if (shares.isZero()) {
        return {
          valid: false,
          error: "ZeroShares: shares amount cannot be zero",
        };
      }
      return { valid: true };
    };

    it("rejects zero deposit", () => {
      const result = validateDepositAmount(new BN(0));
      expect(result.valid).to.be.false;
      expect(result.error).to.include("ZeroAssets");
    });

    it("rejects deposit below minimum", () => {
      const result = validateDepositAmount(new BN(999));
      expect(result.valid).to.be.false;
      expect(result.error).to.include("DepositTooSmall");
    });

    it("accepts valid deposit", () => {
      const result = validateDepositAmount(new BN(1000));
      expect(result.valid).to.be.true;
    });

    it("accepts large deposit", () => {
      const result = validateDepositAmount(new BN("1000000000000000000"));
      expect(result.valid).to.be.true;
    });

    it("rejects zero shares", () => {
      const result = validateSharesAmount(new BN(0));
      expect(result.valid).to.be.false;
      expect(result.error).to.include("ZeroShares");
    });

    it("accepts valid shares", () => {
      const result = validateSharesAmount(new BN(1));
      expect(result.valid).to.be.true;
    });
  });

  describe("Balance Validation", () => {
    const validateSufficientBalance = (
      balance: BN,
      required: BN,
      tokenType: "assets" | "shares",
    ): { valid: boolean; error?: string } => {
      if (balance.lt(required)) {
        const errorCode =
          tokenType === "assets" ? "InsufficientAssets" : "InsufficientShares";
        return {
          valid: false,
          error: `${errorCode}: balance ${balance.toString()} < required ${required.toString()}`,
        };
      }
      return { valid: true };
    };

    it("validates sufficient assets", () => {
      const result = validateSufficientBalance(
        new BN(1000),
        new BN(500),
        "assets",
      );
      expect(result.valid).to.be.true;
    });

    it("rejects insufficient assets", () => {
      const result = validateSufficientBalance(
        new BN(500),
        new BN(1000),
        "assets",
      );
      expect(result.valid).to.be.false;
      expect(result.error).to.include("InsufficientAssets");
    });

    it("validates sufficient shares", () => {
      const result = validateSufficientBalance(
        new BN(1000),
        new BN(1000),
        "shares",
      );
      expect(result.valid).to.be.true;
    });

    it("rejects insufficient shares", () => {
      const result = validateSufficientBalance(
        new BN(999),
        new BN(1000),
        "shares",
      );
      expect(result.valid).to.be.false;
      expect(result.error).to.include("InsufficientShares");
    });
  });

  describe("Overflow Protection", () => {
    const safeMulDiv = (
      value: BN,
      numerator: BN,
      denominator: BN,
    ): { result: BN; overflow: boolean } => {
      try {
        // Use BN's built-in overflow protection
        const product = value.mul(numerator);
        const result = product.div(denominator);
        return { result, overflow: false };
      } catch {
        return { result: new BN(0), overflow: true };
      }
    };

    it("handles normal multiplication", () => {
      const result = safeMulDiv(new BN(1000), new BN(2), new BN(1));
      expect(result.overflow).to.be.false;
      expect(result.result.toNumber()).to.equal(2000);
    });

    it("handles large numbers without overflow", () => {
      const largeValue = new BN("18446744073709551615"); // u64::MAX
      const result = safeMulDiv(largeValue, new BN(1), new BN(2));
      expect(result.overflow).to.be.false;
      expect(result.result.gt(new BN(0))).to.be.true;
    });

    it("handles division correctly", () => {
      const result = safeMulDiv(new BN(1000), new BN(3), new BN(10));
      expect(result.overflow).to.be.false;
      expect(result.result.toNumber()).to.equal(300);
    });
  });

  describe("Paused State Validation", () => {
    const validateNotPaused = (
      isPaused: boolean,
    ): { valid: boolean; error?: string } => {
      if (isPaused) {
        return {
          valid: false,
          error: "VaultPaused: vault is currently paused",
        };
      }
      return { valid: true };
    };

    it("passes when not paused", () => {
      const result = validateNotPaused(false);
      expect(result.valid).to.be.true;
    });

    it("fails when paused", () => {
      const result = validateNotPaused(true);
      expect(result.valid).to.be.false;
      expect(result.error).to.include("VaultPaused");
    });
  });
});
