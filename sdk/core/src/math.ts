import { BN } from "@coral-xyz/anchor";

export enum Rounding {
  Floor,
  Ceiling,
}

const MAX_DECIMALS = 9;

/**
 * Calculate virtual offset based on decimals offset
 * This provides inflation attack protection
 */
function getVirtualOffset(decimalsOffset: number): BN {
  return new BN(10).pow(new BN(decimalsOffset));
}

/**
 * Multiply then divide with specified rounding
 */
function mulDiv(
  value: BN,
  numerator: BN,
  denominator: BN,
  rounding: Rounding,
): BN {
  if (denominator.isZero()) {
    throw new Error("Division by zero");
  }

  const product = value.mul(numerator);

  if (rounding === Rounding.Floor) {
    return product.div(denominator);
  } else {
    // Ceiling: (a + b - 1) / b
    return product.add(denominator).sub(new BN(1)).div(denominator);
  }
}

/**
 * Convert assets to shares (ERC-4626 formula with virtual offset)
 *
 * shares = (assets * (totalShares + virtualOffset)) / (totalAssets + 1)
 */
export function convertToShares(
  assets: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
  rounding: Rounding = Rounding.Floor,
): BN {
  const virtualOffset = getVirtualOffset(decimalsOffset);
  const virtualShares = totalShares.add(virtualOffset);
  const virtualAssets = totalAssets.add(new BN(1));

  return mulDiv(assets, virtualShares, virtualAssets, rounding);
}

/**
 * Convert shares to assets (ERC-4626 formula with virtual offset)
 *
 * assets = (shares * (totalAssets + 1)) / (totalShares + virtualOffset)
 */
export function convertToAssets(
  shares: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
  rounding: Rounding = Rounding.Floor,
): BN {
  const virtualOffset = getVirtualOffset(decimalsOffset);
  const virtualShares = totalShares.add(virtualOffset);
  const virtualAssets = totalAssets.add(new BN(1));

  return mulDiv(shares, virtualAssets, virtualShares, rounding);
}

/**
 * Preview deposit: how many shares for given assets (floor rounding)
 */
export function previewDeposit(
  assets: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
): BN {
  return convertToShares(
    assets,
    totalAssets,
    totalShares,
    decimalsOffset,
    Rounding.Floor,
  );
}

/**
 * Preview mint: how many assets for given shares (ceiling rounding)
 */
export function previewMint(
  shares: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
): BN {
  return convertToAssets(
    shares,
    totalAssets,
    totalShares,
    decimalsOffset,
    Rounding.Ceiling,
  );
}

/**
 * Preview withdraw: how many shares to burn for assets (ceiling rounding)
 */
export function previewWithdraw(
  assets: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
): BN {
  return convertToShares(
    assets,
    totalAssets,
    totalShares,
    decimalsOffset,
    Rounding.Ceiling,
  );
}

/**
 * Preview redeem: how many assets for shares (floor rounding)
 */
export function previewRedeem(
  shares: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number,
): BN {
  return convertToAssets(
    shares,
    totalAssets,
    totalShares,
    decimalsOffset,
    Rounding.Floor,
  );
}

/**
 * Calculate decimals offset for an asset
 */
export function calculateDecimalsOffset(assetDecimals: number): number {
  if (assetDecimals > MAX_DECIMALS) {
    throw new Error(
      `Asset decimals ${assetDecimals} exceeds maximum ${MAX_DECIMALS}`,
    );
  }
  return MAX_DECIMALS - assetDecimals;
}
