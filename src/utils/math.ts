import { BigNumber } from "ethers";

// ---------------------------------------------------------------------------
// Uniswap V3 price math
// ---------------------------------------------------------------------------

/**
 * Convert a Uniswap V3 `sqrtPriceX96` value to a human-readable price.
 *
 * Background:
 *   Uniswap V3 stores the square root of the token1/token0 price in a
 *   Q64.96 fixed-point format.  Concretely:
 *
 *     sqrtPriceX96 = sqrt(token1_reserve / token0_reserve) * 2^96
 *
 *   Both reserves are measured in the token's smallest unit (wei), so the
 *   raw price ratio is token1-wei per token0-wei.
 *
 * This function returns the price of ONE human-readable unit of token0
 * denominated in human-readable units of token1.
 *
 * @param sqrtPriceX96 - value from `slot0()` (BigNumber or native bigint)
 * @param decimals0    - decimals of token0 (the lower-address token in the pool)
 * @param decimals1    - decimals of token1
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint | BigNumber,
  decimals0: number,
  decimals1: number
): number {
  const sqrtP =
    typeof sqrtPriceX96 === "bigint"
      ? sqrtPriceX96
      : BigInt(sqrtPriceX96.toString());

  // We compute  (sqrtP / 2^96)^2  using integer arithmetic to stay precise,
  // then convert to a JS float at the very end.
  //
  // Scaling strategy: divide sqrtP by 2^96 using an intermediate precision
  // factor of 10^9 to keep fractional parts.
  //
  //   scaledSqrtP = sqrtP * 10^9 / 2^96           (integer)
  //   rawPrice    = (scaledSqrtP / 10^9)^2         (float)
  //               = scaledSqrtP^2 / 10^18
  const SCALE = 10n ** 9n;
  const Q96 = 2n ** 96n;

  const scaledSqrt = (sqrtP * SCALE) / Q96;
  // rawPrice is the wei-level ratio: token1-wei per token0-wei
  const rawPrice =
    Number(scaledSqrt * scaledSqrt) / Number(SCALE * SCALE);

  // Adjust for the difference in decimal places so that we express the price
  // in human-readable units:
  //   human_price = rawPrice * 10^decimals0 / 10^decimals1
  const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
  return rawPrice * decimalAdjustment;
}

/**
 * Returns `1 / sqrtPriceX96ToPrice(...)`.
 * Useful when you want the price of token1 denominated in token0.
 */
export function sqrtPriceX96ToInversePrice(
  sqrtPriceX96: bigint | BigNumber,
  decimals0: number,
  decimals1: number
): number {
  const p = sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1);
  return p > 0 ? 1 / p : 0;
}

// ---------------------------------------------------------------------------
// Price comparison helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute percentage difference between two prices.
 *
 *   diff = |priceA - priceB| / min(priceA, priceB) * 100
 */
export function priceDifferencePercent(priceA: number, priceB: number): number {
  if (priceA <= 0 || priceB <= 0) return 0;
  return (Math.abs(priceA - priceB) / Math.min(priceA, priceB)) * 100;
}

// ---------------------------------------------------------------------------
// Token amount conversions
// ---------------------------------------------------------------------------

/**
 * Convert a human-readable token amount (string or number) to its wei
 * representation as a native bigint.
 *
 * Example: toTokenAmount("1.5", 6) => 1_500_000n  (for USDC)
 */
export function toTokenAmount(amount: string | number, decimals: number): bigint {
  // Use toFixed to handle floating-point imprecision; then parse as integer.
  const amountNum =
    typeof amount === "number" ? amount : parseFloat(amount);

  if (!isFinite(amountNum)) {
    throw new Error(`toTokenAmount: non-finite amount "${amount}"`);
  }
  if (amountNum < 0) {
    throw new Error(`toTokenAmount: negative amount "${amount}"`);
  }
  if (amountNum === 0) return 0n;

  // toFixed gives us the exact decimal representation
  const str = amountNum.toFixed(decimals);
  const [whole, frac = ""] = str.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);

  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded);
}

/**
 * Convert a wei amount (bigint) to its human-readable float.
 *
 * Example: fromTokenAmount(1_500_000n, 6) => 1.5
 */
export function fromTokenAmount(amount: bigint, decimals: number): number {
  const factor = BigInt(10 ** decimals);
  const whole = amount / factor;
  const frac = amount % factor;
  return Number(whole) + Number(frac) / Number(factor);
}

// ---------------------------------------------------------------------------
// Slippage
// ---------------------------------------------------------------------------

/**
 * Apply a slippage tolerance to an expected output amount.
 *
 *   amountOutMinimum = expectedAmount * (1 - slippagePercent / 100)
 *
 * Uses basis-point arithmetic to avoid floating-point drift.
 *
 * @param expectedAmount - expected token output in wei (bigint)
 * @param slippagePercent - tolerance as a percentage, e.g. 0.5 for 0.5%
 */
export function applySlippage(
  expectedAmount: bigint,
  slippagePercent: number
): bigint {
  // Convert percent → basis points (1% = 100 bps)
  const slippageBps = Math.round(slippagePercent * 100);
  return (expectedAmount * BigInt(10_000 - slippageBps)) / 10_000n;
}
