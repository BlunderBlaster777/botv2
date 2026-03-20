/**
 * trade/index.ts
 *
 * Builds and sends Uniswap V3 exactInputSingle swaps.
 *
 * The arbitrage consists of two sequential swaps:
 *   Swap 1 – tokenA → tokenB on the "buy" pool (cheaper tokenB)
 *   Swap 2 – tokenB → tokenA on the "sell" pool (more expensive tokenB)
 *
 * Safety features:
 *   - Checks and sets ERC-20 allowances before swapping.
 *   - Applies a configurable slippage tolerance via amountOutMinimum.
 *   - Uses a 5-minute deadline on each swap.
 *   - Adds a 20% gas-limit buffer on top of the on-chain estimate.
 */

import { ethers, BigNumber } from "ethers";
import { BotConfig, PoolConfig, TokenConfig } from "../config";
import { ArbitrageOpportunity } from "../onchain";
import { logger } from "../utils/logger";
import { applySlippage, fromTokenAmount } from "../utils/math";

import ISwapRouterABI from "../abis/ISwapRouter.json";
import IERC20ABI from "../abis/IERC20.json";

// Deadline buffer added to the current timestamp for every swap
const DEADLINE_BUFFER_SECONDS = 5 * 60; // 5 minutes

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure that the Uniswap router has a sufficient ERC-20 allowance.
 * If not, sends an approve(router, MaxUint256) transaction and waits for it.
 */
async function ensureAllowance(
  signer: ethers.Signer,
  tokenAddress: string,
  routerAddress: string,
  requiredAmount: bigint
): Promise<void> {
  const token = new ethers.Contract(tokenAddress, IERC20ABI, signer);
  const owner = await signer.getAddress();

  const current: BigNumber = await token.allowance(owner, routerAddress);
  if (BigInt(current.toString()) >= requiredAmount) {
    return; // already approved
  }

  logger.info(`Approving ${tokenAddress} for router ${routerAddress} …`);
  const tx: ethers.providers.TransactionResponse = await token.approve(
    routerAddress,
    ethers.constants.MaxUint256
  );
  const receipt = await tx.wait();
  logger.success(
    `Approval confirmed in block ${receipt.blockNumber}: ${receipt.transactionHash}`
  );
}

/**
 * Build and send a single exactInputSingle swap.
 *
 * @returns The mined transaction receipt.
 */
async function sendSwap(
  signer: ethers.Signer,
  routerAddress: string,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint,
  amountOutMinimum: bigint
): Promise<ethers.providers.TransactionReceipt> {
  const router = new ethers.Contract(routerAddress, ISwapRouterABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_BUFFER_SECONDS;
  const recipient = await signer.getAddress();

  const params = {
    tokenIn,
    tokenOut,
    fee,
    recipient,
    deadline,
    amountIn: BigNumber.from(amountIn.toString()),
    amountOutMinimum: BigNumber.from(amountOutMinimum.toString()),
    sqrtPriceLimitX96: 0, // 0 = no price limit; amountOutMinimum is the guard
  };

  // Estimate gas on-chain, then add a 20% safety buffer
  const gasEstimate: BigNumber =
    await router.estimateGas.exactInputSingle(params);
  const gasLimit = gasEstimate.mul(120).div(100);

  const tx: ethers.providers.TransactionResponse =
    await router.exactInputSingle(params, { gasLimit });

  logger.info(`Swap tx submitted: ${tx.hash} – waiting for confirmation …`);
  return tx.wait();
}

// ---------------------------------------------------------------------------
// Gas estimation (exported for profitability pre-check)
// ---------------------------------------------------------------------------

/**
 * Estimate the total MATIC cost (in wei, as a bigint) of executing both swaps.
 *
 * Falls back to a conservative constant if estimation fails (e.g. because the
 * wallet's token balance is zero and the simulation reverts).
 */
export async function estimateTotalGasCost(
  provider: ethers.providers.Provider,
  signer: ethers.Signer,
  routerAddress: string,
  tokenA: TokenConfig,
  tokenB: TokenConfig,
  buyPoolFee: number,
  sellPoolFee: number,
  tradeAmountA: bigint,
  expectedAmountB: bigint
): Promise<bigint> {
  const router = new ethers.Contract(routerAddress, ISwapRouterABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_BUFFER_SECONDS;
  const recipient = await signer.getAddress();

  const params1 = {
    tokenIn: tokenA.address,
    tokenOut: tokenB.address,
    fee: buyPoolFee,
    recipient,
    deadline,
    amountIn: BigNumber.from(tradeAmountA.toString()),
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  };

  const params2 = {
    tokenIn: tokenB.address,
    tokenOut: tokenA.address,
    fee: sellPoolFee,
    recipient,
    deadline,
    amountIn: BigNumber.from(expectedAmountB.toString()),
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  };

  // Estimate gas for both swaps; if either fails, fall back to 300 000 gas
  const FALLBACK_GAS = BigNumber.from(300_000);
  const [gas1, gas2, gasPrice] = await Promise.all([
    router.estimateGas
      .exactInputSingle(params1)
      .catch(() => FALLBACK_GAS),
    router.estimateGas
      .exactInputSingle(params2)
      .catch(() => FALLBACK_GAS),
    provider.getGasPrice(),
  ]);

  // Add 30% buffer to the combined estimate
  const totalGas = gas1.add(gas2).mul(130).div(100);
  return BigInt(totalGas.mul(gasPrice).toString());
}

// ---------------------------------------------------------------------------
// Trade result type
// ---------------------------------------------------------------------------

export interface TradeResult {
  success: boolean;
  txHash1?: string;
  txHash2?: string;
  /** Actual tokenA amount received (human-readable), if available. */
  actualAmountAOut?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Main trade executor
// ---------------------------------------------------------------------------

/**
 * Execute the full arbitrage: two sequential Uniswap V3 swaps.
 *
 * Step 1 – swap tokenA → tokenB on the cheaper pool (buyPool).
 * Step 2 – swap tokenB → tokenA on the more expensive pool (sellPool).
 *
 * Slippage protection is applied to both amountOutMinimum values.
 * All approvals are handled automatically before the first swap.
 */
export async function executeArbitrage(
  signer: ethers.Signer,
  config: BotConfig,
  opportunity: ArbitrageOpportunity
): Promise<TradeResult> {
  const {
    pairData,
    buyPool,
    tradeAmountA,
    expectedAmountB,
    expectedAmountAOut,
  } = opportunity;

  const { pairConfig } = pairData;
  const { tokenA, tokenB, poolA, poolB } = pairConfig;
  const routerAddress = config.uniswapRouterAddress;

  const buyPoolConfig: PoolConfig = buyPool === "A" ? poolA : poolB;
  const sellPoolConfig: PoolConfig = buyPool === "A" ? poolB : poolA;

  // Apply slippage to the minimum tokenB we'll accept from swap 1.
  // For swap 2 the minimum is recomputed after swap 1 using the actual balance.
  const amountBMin = applySlippage(expectedAmountB, config.maxSlippagePercent);

  try {
    // ── Approve both tokens in parallel ────────────────────────────────────
    await Promise.all([
      ensureAllowance(
        signer,
        tokenA.address,
        routerAddress,
        tradeAmountA
      ),
      ensureAllowance(
        signer,
        tokenB.address,
        routerAddress,
        expectedAmountB
      ),
    ]);

    // ── Swap 1: tokenA → tokenB (buy tokenB cheap) ─────────────────────────
    logger.info(
      `${pairConfig.name} | Swap 1: ${tokenA.symbol} → ${tokenB.symbol} ` +
        `via Pool ${buyPool} (fee ${buyPoolConfig.fee / 10_000}%)`
    );

    const receipt1 = await sendSwap(
      signer,
      routerAddress,
      tokenA.address,
      tokenB.address,
      buyPoolConfig.fee,
      tradeAmountA,
      amountBMin
    );

    logger.success(
      `${pairConfig.name} | Swap 1 confirmed in block ${receipt1.blockNumber} ` +
        `(gas used: ${receipt1.gasUsed.toString()})`
    );

    // Read the actual tokenB balance received from swap 1.
    // Using the real balance avoids any discrepancy between the estimated
    // expectedAmountB and what the pool actually transferred.
    const tokenBContract = new ethers.Contract(tokenB.address, IERC20ABI, signer);
    const actualBalanceBRaw: BigNumber = await tokenBContract.balanceOf(
      await signer.getAddress()
    );
    const actualAmountB = BigInt(actualBalanceBRaw.toString());

    if (actualAmountB === 0n) {
      return {
        success: false,
        error: "Swap 1 produced 0 tokenB – aborting before swap 2",
      };
    }

    // Re-compute amountOutMinimum for swap 2 based on the actual tokenB amount.
    const amountAOutMinActual = applySlippage(
      // Scale the expected tokenA out proportionally to the actual tokenB received
      (expectedAmountAOut * actualAmountB) / expectedAmountB,
      config.maxSlippagePercent
    );

    // Ensure the router allowance covers the actual amount we received
    await ensureAllowance(signer, tokenB.address, routerAddress, actualAmountB);

    // ── Swap 2: tokenB → tokenA (sell tokenB dear) ─────────────────────────
    logger.info(
      `${pairConfig.name} | Swap 2: ${tokenB.symbol} → ${tokenA.symbol} ` +
        `via Pool ${buyPool === "A" ? "B" : "A"} (fee ${sellPoolConfig.fee / 10_000}%)`
    );

    const receipt2 = await sendSwap(
      signer,
      routerAddress,
      tokenB.address,
      tokenA.address,
      sellPoolConfig.fee,
      actualAmountB,
      amountAOutMinActual
    );

    logger.success(
      `${pairConfig.name} | Swap 2 confirmed in block ${receipt2.blockNumber} ` +
        `(gas used: ${receipt2.gasUsed.toString()})`
    );

    const totalGasUsed = receipt1.gasUsed
      .add(receipt2.gasUsed)
      .toString();

    logger.trade(
      pairConfig.name,
      receipt1.transactionHash,
      receipt2.transactionHash,
      opportunity.estimatedProfitTokenA,
      tokenA.symbol,
      totalGasUsed
    );

    return {
      success: true,
      txHash1: receipt1.transactionHash,
      txHash2: receipt2.transactionHash,
      actualAmountAOut: fromTokenAmount(
        expectedAmountAOut,
        tokenA.decimals
      ),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
