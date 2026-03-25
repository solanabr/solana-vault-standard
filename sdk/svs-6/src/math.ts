import BN from "bn.js";

const ZERO = new BN(0);
const ONE = new BN(1);

/** Calculate the virtual offset for inflation protection. */
export function calculateOffset(decimalsOffset: number): BN {
  return new BN(10).pow(new BN(decimalsOffset));
}

/** Calculate accrued streaming yield at a given timestamp. */
export function calculateAccrued(
  streamAmount: BN,
  streamStart: BN,
  streamEnd: BN,
  currentTimestamp: BN
): BN {
  if (streamAmount.isZero() || streamEnd.lte(streamStart)) {
    return ZERO;
  }

  const duration = streamEnd.sub(streamStart);
  const elapsed = BN.max(currentTimestamp.sub(streamStart), ZERO);
  const cappedElapsed = BN.min(elapsed, duration);

  // accrued = streamAmount * cappedElapsed / duration
  return streamAmount.mul(cappedElapsed).div(duration);
}

/** Calculate effective total assets including streaming yield. */
export function effectiveTotalAssets(
  baseAssets: BN,
  streamAmount: BN,
  streamStart: BN,
  streamEnd: BN,
  currentTimestamp: BN
): BN {
  const accrued = calculateAccrued(
    streamAmount,
    streamStart,
    streamEnd,
    currentTimestamp
  );
  return baseAssets.add(accrued);
}

/** Convert assets to shares with virtual offset (floor rounding). */
export function convertToShares(
  assets: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number
): BN {
  const offset = calculateOffset(decimalsOffset);
  const virtualShares = totalShares.add(offset);
  const virtualAssets = totalAssets.add(ONE);

  // shares = assets * virtualShares / virtualAssets (floor)
  return assets.mul(virtualShares).div(virtualAssets);
}

/** Convert shares to assets with virtual offset (floor rounding). */
export function convertToAssets(
  shares: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number
): BN {
  const offset = calculateOffset(decimalsOffset);
  const virtualShares = totalShares.add(offset);
  const virtualAssets = totalAssets.add(ONE);

  // assets = shares * virtualAssets / virtualShares (floor)
  return shares.mul(virtualAssets).div(virtualShares);
}

/** Convert assets to shares with ceiling rounding (for withdraw). */
export function convertToSharesCeil(
  assets: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number
): BN {
  const offset = calculateOffset(decimalsOffset);
  const virtualShares = totalShares.add(offset);
  const virtualAssets = totalAssets.add(ONE);

  // ceil(assets * virtualShares / virtualAssets)
  const numerator = assets.mul(virtualShares);
  return numerator.add(virtualAssets).sub(ONE).div(virtualAssets);
}

/** Convert shares to assets with ceiling rounding (for mint). */
export function convertToAssetsCeil(
  shares: BN,
  totalAssets: BN,
  totalShares: BN,
  decimalsOffset: number
): BN {
  const offset = calculateOffset(decimalsOffset);
  const virtualShares = totalShares.add(offset);
  const virtualAssets = totalAssets.add(ONE);

  // ceil(shares * virtualAssets / virtualShares)
  const numerator = shares.mul(virtualAssets);
  return numerator.add(virtualShares).sub(ONE).div(virtualShares);
}

/** Calculate share price as a floating point number (for display only). */
export function sharePrice(totalAssets: BN, totalShares: BN): number {
  if (totalShares.isZero()) return 1.0;
  return totalAssets.toNumber() / totalShares.toNumber();
}
