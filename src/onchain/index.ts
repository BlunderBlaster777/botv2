/**
 * onchain/index.ts
 *
 * Reads live state from Uniswap V3 pools on Polygon and evaluates whether a
 * two-pool arbitrage opportunity exists for a configured token pair.
 *
 * Arbitrage logic (2-token, same pair, different fee tiers):
 *
 *   1. Pool A and Pool B hold the same two tokens at different fee tiers
 *      (e.g. USDC/WETH 0.05% and USDC/WETH 0.30%).
 *   2. When their prices diverge beyond the configured threshold:
 *      a. Swap tokenA → tokenB on the pool where tokenB is cheapest
 *         (= highest priceAInPool, i.e. most tokenB received per tokenA).
 *      b. Swap tokenB → tokenA on the pool where tokenB is most expensive
 *         (= lowest priceAInPool, i.e. least tokenB received per tokenA).
 *   3. The net result is more tokenA than we started with.
 */

import { ethers } from "ethers";
import { PairConfig, PoolConfig, TokenConfig } from "../config";
import { logger } from "../utils/logger";
import {
  sqrtPriceX96ToPrice,
  priceDifferencePercent,
  fromTokenAmount,
  toTokenAmount,
} from "../utils/math";

// Minimal ABIs – only the functions we actually call
import IUniswapV3PoolABI from "../abis/IUniswapV3Pool.json";
import IERC20ABI from "../abis/IERC20.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** On-chain state snapshot of one Uniswap V3 pool. */
export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** Price of token0 in terms of token1 (human-readable, decimal-adjusted). */
  priceToken0InToken1: number;
}

/** Price data fetched for both pools of a trading pair. */
export interface PairPriceData {
  pairConfig: PairConfig;
  poolAState: PoolState;
  poolBState: PoolState;
  /**
   * Price of tokenA in terms of tokenB from Pool A.
   * "How many tokenB do I get for 1 tokenA in this pool?"
   */
  priceAInPoolA: number;
  /** Same metric but from Pool B. */
  priceAInPoolB: number;
  /** Absolute percentage difference between the two prices. */
  diffPercent: number;
  /**
   * True when tokenA's address is lexicographically smaller than tokenB's,
   * meaning tokenA occupies the token0 slot in the Uniswap pool.
   */
  tokenAIsToken0: boolean;
}

/** A detected, potentially profitable arbitrage opportunity. */
export interface ArbitrageOpportunity {
  pairData: PairPriceData;
  /** Pool label where we swap tokenA → tokenB (buy tokenB cheap). */
  buyPool: "A" | "B";
  /** Pool label where we swap tokenB → tokenA (sell tokenB expensive). */
  sellPool: "A" | "B";
  /** Gross estimated profit in human-readable tokenA units (before gas). */
  estimatedProfitTokenA: number;
  /** Amount of tokenA to spend on the first swap (in wei). */
  tradeAmountA: bigint;
  /** Expected tokenB amount received from the first swap (in wei). */
  expectedAmountB: bigint;
  /** Expected tokenA amount received from the second swap (in wei). */
  expectedAmountAOut: bigint;
}

// ---------------------------------------------------------------------------
// Pool state reader
// ---------------------------------------------------------------------------

/**
 * Fetch the current on-chain state of a single Uniswap V3 pool.
 *
 * @param provider   - ethers provider
 * @param poolAddress - checksummed pool address
 * @param decimals0  - decimals of token0 (lower-address token in the pool)
 * @param decimals1  - decimals of token1
 */
export async function readPoolState(
  provider: ethers.providers.Provider,
  poolAddress: string,
  decimals0: number,
  decimals1: number
): Promise<PoolState> {
  const pool = new ethers.Contract(poolAddress, IUniswapV3PoolABI, provider);

  // Fetch slot0 and liquidity in a single round-trip
  const [slot0, liquidity] = await Promise.all([
    pool.slot0() as Promise<{ sqrtPriceX96: ethers.BigNumber; tick: number }>,
    pool.liquidity() as Promise<ethers.BigNumber>,
  ]);

  const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString());
  const priceToken0InToken1 = sqrtPriceX96ToPrice(
    sqrtPriceX96,
    decimals0,
    decimals1
  );

  return {
    sqrtPriceX96,
    tick: slot0.tick,
    liquidity: BigInt(liquidity.toString()),
    priceToken0InToken1,
  };
}

/**
 * Returns true when tokenA is token0 in the Uniswap pool.
 * Uniswap always places the lexicographically smaller address as token0.
 */
export function isTokenAToken0(
  tokenAAddress: string,
  tokenBAddress: string
): boolean {
  return tokenAAddress.toLowerCase() < tokenBAddress.toLowerCase();
}

// ---------------------------------------------------------------------------
// Pair price reader
// ---------------------------------------------------------------------------

/**
 * Fetch pool states for both pools of a pair and derive a unified price view.
 *
 * The returned `priceAInPool{A,B}` fields always express:
 *   "How many tokenB do I receive for 1 tokenA?"
 *
 * regardless of how the tokens are ordered inside each pool.
 */
export async function fetchPairPriceData(
  provider: ethers.providers.Provider,
  pairConfig: PairConfig
): Promise<PairPriceData> {
  const { tokenA, tokenB, poolA, poolB } = pairConfig;

  // Determine token ordering (Uniswap sorts by address)
  const tokenAIsToken0 = isTokenAToken0(tokenA.address, tokenB.address);

  // Pool slot0 always gives priceOf(token0) in token1 units
  const [decimals0, decimals1] = tokenAIsToken0
    ? [tokenA.decimals, tokenB.decimals]
    : [tokenB.decimals, tokenA.decimals];

  // Read both pools in parallel
  const [poolAState, poolBState] = await Promise.all([
    readPoolState(provider, poolA.address, decimals0, decimals1),
    readPoolState(provider, poolB.address, decimals0, decimals1),
  ]);

  // Convert to "price of tokenA in tokenB"
  // If tokenA == token0  →  use the price directly
  // If tokenA == token1  →  take the reciprocal
  const priceAInPoolA = tokenAIsToken0
    ? poolAState.priceToken0InToken1
    : 1 / poolAState.priceToken0InToken1;

  const priceAInPoolB = tokenAIsToken0
    ? poolBState.priceToken0InToken1
    : 1 / poolBState.priceToken0InToken1;

  const diffPercent = priceDifferencePercent(priceAInPoolA, priceAInPoolB);

  return {
    pairConfig,
    poolAState,
    poolBState,
    priceAInPoolA,
    priceAInPoolB,
    diffPercent,
    tokenAIsToken0,
  };
}

// ---------------------------------------------------------------------------
// Arbitrage opportunity detector
// ---------------------------------------------------------------------------

/**
 * Given a price snapshot, determine whether a profitable arbitrage exists.
 *
 * Returns `null` when no opportunity meets the configured thresholds.
 *
 * The rough profit model (fees included, gas NOT included):
 *
 *   step1:  tokenA  →  tokenB   (at buyPool,  price = buyPrice)
 *     tokenB_received = tradeAmountA * buyPrice * (1 - buyFee)
 *
 *   step2:  tokenB  →  tokenA   (at sellPool, price = sellPrice)
 *     tokenA_received = tokenB_received / sellPrice * (1 - sellFee)
 *
 *   profit  = tokenA_received - tradeAmountA
 *
 * The caller should additionally estimate gas cost and compare against profit.
 */
export async function checkArbitrageOpportunity(
  pairData: PairPriceData,
  minProfitThresholdPercent: number
): Promise<ArbitrageOpportunity | null> {
  const { pairConfig, priceAInPoolA, priceAInPoolB, diffPercent } = pairData;

  // Quick check: is the price spread large enough?
  if (diffPercent < minProfitThresholdPercent) {
    return null;
  }

  // "Buy tokenB cheap" pool  = pool where priceAInPool is HIGHER
  //   (more tokenB per tokenA  →  tokenB is cheaper there)
  // "Sell tokenB dear" pool   = pool where priceAInPool is LOWER
  //   (fewer tokenB per tokenA →  tokenB is more expensive there)
  const buyPool: "A" | "B" = priceAInPoolA > priceAInPoolB ? "A" : "B";
  const sellPool: "A" | "B" = buyPool === "A" ? "B" : "A";

  const buyPrice = buyPool === "A" ? priceAInPoolA : priceAInPoolB;
  const sellPrice = buyPool === "A" ? priceAInPoolB : priceAInPoolA;
  const buyFee = (buyPool === "A" ? pairConfig.poolA : pairConfig.poolB).fee;
  const sellFee = (buyPool === "A" ? pairConfig.poolB : pairConfig.poolA).fee;

  // Trade size in wei
  const tradeAmountA = toTokenAmount(
    pairConfig.tradeSizeA,
    pairConfig.tokenA.decimals
  );
  const tradeAmountAHuman = fromTokenAmount(
    tradeAmountA,
    pairConfig.tokenA.decimals
  );

  // Step 1 estimate: how much tokenB do we receive?
  // fee is in millionths (e.g. 500 = 0.05%)
  const feeMultiplierBuy = 1 - buyFee / 1_000_000;
  const expectedTokenBHuman =
    tradeAmountAHuman * buyPrice * feeMultiplierBuy;

  if (expectedTokenBHuman <= 0) return null;

  const expectedAmountB = toTokenAmount(
    expectedTokenBHuman,
    pairConfig.tokenB.decimals
  );

  // Step 2 estimate: how much tokenA do we get back?
  // sellPrice is "tokenB per tokenA", so inverse = "tokenA per tokenB"
  const feeMultiplierSell = 1 - sellFee / 1_000_000;
  const expectedTokenAOutHuman =
    expectedTokenBHuman * (1 / sellPrice) * feeMultiplierSell;

  const expectedAmountAOut = toTokenAmount(
    expectedTokenAOutHuman,
    pairConfig.tokenA.decimals
  );

  // Gross profit in tokenA (before gas deduction)
  const estimatedProfitTokenA = expectedTokenAOutHuman - tradeAmountAHuman;

  if (estimatedProfitTokenA <= 0) {
    logger.info(
      `${pairConfig.name} | Spread present (${diffPercent.toFixed(4)}%) but ` +
        `estimated profit ≤ 0 after pool fees – skipping`
    );
    return null;
  }

  return {
    pairData,
    buyPool,
    sellPool,
    estimatedProfitTokenA,
    tradeAmountA,
    expectedAmountB,
    expectedAmountAOut,
  };
}

// ---------------------------------------------------------------------------
// Wallet balance checker
// ---------------------------------------------------------------------------

/** Read tokenA, tokenB, and native MATIC balances for the given wallet. */
export async function checkBalances(
  provider: ethers.providers.Provider,
  walletAddress: string,
  tokenA: TokenConfig,
  tokenB: TokenConfig
): Promise<{ balanceA: number; balanceB: number; maticBalance: number }> {
  const tokenAContract = new ethers.Contract(tokenA.address, IERC20ABI, provider);
  const tokenBContract = new ethers.Contract(tokenB.address, IERC20ABI, provider);

  const [rawA, rawB, rawMatic] = await Promise.all([
    tokenAContract.balanceOf(walletAddress) as Promise<ethers.BigNumber>,
    tokenBContract.balanceOf(walletAddress) as Promise<ethers.BigNumber>,
    provider.getBalance(walletAddress),
  ]);

  return {
    balanceA: fromTokenAmount(BigInt(rawA.toString()), tokenA.decimals),
    balanceB: fromTokenAmount(BigInt(rawB.toString()), tokenB.decimals),
    maticBalance: fromTokenAmount(BigInt(rawMatic.toString()), 18),
  };
}
