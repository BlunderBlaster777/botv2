/**
 * main.ts – Entry point for the Uniswap V3 arbitrage bot.
 *
 * Lifecycle:
 *   1. Load configuration from .env
 *   2. Connect to Polygon via RPC
 *   3. Enter an infinite polling loop:
 *        a. For each configured pair, read prices from both Uniswap V3 pools.
 *        b. Log prices.
 *        c. If price difference exceeds the threshold, evaluate the trade.
 *        d. Estimate gas cost; skip if trade is not profitable after gas.
 *        e. In dry-run mode: log what would have happened.
 *           In live mode:   execute both swaps and log the result.
 *   4. Wait for the configured poll interval and repeat.
 *
 * Run with:
 *   DRY_RUN=true npx ts-node src/main.ts    # dry-run (safe, no real txs)
 *   DRY_RUN=false npx ts-node src/main.ts   # live mode (real trades!)
 */

import { ethers } from "ethers";
import { loadConfig } from "./config";
import {
  fetchPairPriceData,
  checkArbitrageOpportunity,
  checkBalances,
} from "./onchain";
import { estimateTotalGasCost, executeArbitrage } from "./trade";
import { logger } from "./utils/logger";
import { fromTokenAmount } from "./utils/math";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── 1. Load config ────────────────────────────────────────────────────────
  const config = loadConfig();

  logger.info("═══════════════════════════════════════════════");
  logger.info("  Uniswap V3 Arbitrage Bot – Polygon PoS");
  logger.info("═══════════════════════════════════════════════");
  logger.info(
    `Mode       : ${config.dryRun ? "DRY RUN (no real transactions)" : "⚡ LIVE TRADING"}`
  );
  logger.info(`Wallet     : ${config.walletAddress}`);
  logger.info(
    `Pairs      : ${config.pairs.map((p) => p.name).join(", ")}`
  );
  logger.info(
    `Threshold  : ${config.minProfitThresholdPercent}% price diff`
  );
  logger.info(`Max slip.  : ${config.maxSlippagePercent}%`);
  logger.info(`Poll every : ${config.pollIntervalMs} ms`);
  logger.info("─────────────────────────────────────────────");

  // ── 2. Connect to Polygon ─────────────────────────────────────────────────
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const signer = new ethers.Wallet(config.privateKey, provider);

  // Verify network
  const network = await provider.getNetwork();
  logger.info(
    `Network    : ${network.name} (chainId ${network.chainId})`
  );
  if (network.chainId !== 137) {
    const msg =
      `Expected Polygon PoS (chainId 137) but got chainId ${network.chainId}. ` +
      `Double-check your RPC_URL in .env.`;
    if (!config.dryRun) {
      logger.error(msg + " Exiting to prevent trading on the wrong network.");
      process.exit(1);
    }
    logger.warn(msg);
  }

  // Verify MATIC balance for gas
  const maticBal = await provider.getBalance(config.walletAddress);
  logger.info(`MATIC bal  : ${ethers.utils.formatEther(maticBal)} MATIC`);
  if (!config.dryRun && maticBal.isZero()) {
    logger.warn("Wallet has no MATIC – swaps will fail due to insufficient gas.");
  }

  logger.info("─────────────────────────────────────────────");
  logger.info("Starting polling loop …");

  // ── 3. Main polling loop ──────────────────────────────────────────────────
  let iteration = 0;

  while (true) {
    iteration++;
    logger.info(`\n┌── Iteration ${iteration} ────────────────────────────`);

    for (const pairConfig of config.pairs) {
      try {
        // ── a. Read prices from both pools ───────────────────────────────
        const pairData = await fetchPairPriceData(provider, pairConfig);

        // ── b. Log current prices ────────────────────────────────────────
        logger.price(
          pairConfig.name,
          `Pool A (${pairConfig.poolA.fee / 10_000}% fee)`,
          pairData.priceAInPoolA
        );
        logger.price(
          pairConfig.name,
          `Pool B (${pairConfig.poolB.fee / 10_000}% fee)`,
          pairData.priceAInPoolB
        );
        logger.info(
          `${pairConfig.name} | Price diff: ${pairData.diffPercent.toFixed(4)}%`
        );

        // ── c. Check for opportunity ─────────────────────────────────────
        const opportunity = await checkArbitrageOpportunity(
          pairData,
          config.minProfitThresholdPercent
        );

        if (!opportunity) {
          logger.info(
            `${pairConfig.name} | No opportunity ` +
              `(diff ${pairData.diffPercent.toFixed(4)}% < ` +
              `threshold ${config.minProfitThresholdPercent}%)`
          );
          continue;
        }

        logger.opportunity(
          pairConfig.name,
          pairData.diffPercent,
          opportunity.estimatedProfitTokenA,
          pairConfig.tokenA.symbol
        );

        // ── d. Estimate gas cost and check net profitability ─────────────
        const buyPoolFee = (
          opportunity.buyPool === "A" ? pairConfig.poolA : pairConfig.poolB
        ).fee;
        const sellPoolFee = (
          opportunity.buyPool === "A" ? pairConfig.poolB : pairConfig.poolA
        ).fee;

        let gasCostMatic = 0;
        try {
          const gasCostWei = await estimateTotalGasCost(
            provider,
            signer,
            config.uniswapRouterAddress,
            pairConfig.tokenA,
            pairConfig.tokenB,
            buyPoolFee,
            sellPoolFee,
            opportunity.tradeAmountA,
            opportunity.expectedAmountB
          );
          gasCostMatic = fromTokenAmount(gasCostWei, 18);
          logger.info(
            `${pairConfig.name} | Est. gas cost: ${gasCostMatic.toFixed(6)} MATIC`
          );
        } catch (gasErr) {
          logger.warn(
            `${pairConfig.name} | Gas estimation failed (${
              gasErr instanceof Error ? gasErr.message : gasErr
            }). Proceeding with gross-profit check only.`
          );
        }

        // Simple profitability guard: gross profit > 0.
        // For a production bot you would convert gasCostMatic to tokenA terms
        // (using a MATIC/tokenA price feed) and ensure profit > gas cost.
        if (opportunity.estimatedProfitTokenA <= 0) {
          logger.warn(
            `${pairConfig.name} | Gross profit ≤ 0 after fees – skipping`
          );
          continue;
        }

        // ── e. Check balance ─────────────────────────────────────────────
        const balances = await checkBalances(
          provider,
          config.walletAddress,
          pairConfig.tokenA,
          pairConfig.tokenB
        );

        const tradeAmountAHuman = fromTokenAmount(
          opportunity.tradeAmountA,
          pairConfig.tokenA.decimals
        );

        logger.info(
          `${pairConfig.name} | Balances: ` +
            `${balances.balanceA.toFixed(4)} ${pairConfig.tokenA.symbol}, ` +
            `${balances.balanceB.toFixed(6)} ${pairConfig.tokenB.symbol}, ` +
            `${balances.maticBalance.toFixed(4)} MATIC`
        );

        if (balances.balanceA < tradeAmountAHuman) {
          logger.warn(
            `${pairConfig.name} | Insufficient ${pairConfig.tokenA.symbol}. ` +
              `Have ${balances.balanceA.toFixed(4)}, need ${tradeAmountAHuman.toFixed(4)}`
          );
          continue;
        }

        // ── f. Execute or simulate ────────────────────────────────────────
        if (config.dryRun) {
          logger.dryRun(
            pairConfig.name,
            "Would trade",
            `Buy ${pairConfig.tokenB.symbol} in Pool ${opportunity.buyPool} ` +
              `@ ${
                opportunity.buyPool === "A"
                  ? pairData.priceAInPoolA.toFixed(8)
                  : pairData.priceAInPoolB.toFixed(8)
              }, ` +
              `sell in Pool ${opportunity.sellPool} ` +
              `@ ${
                opportunity.sellPool === "A"
                  ? pairData.priceAInPoolA.toFixed(8)
                  : pairData.priceAInPoolB.toFixed(8)
              } | ` +
              `Est. profit: ${opportunity.estimatedProfitTokenA.toFixed(4)} ` +
              `${pairConfig.tokenA.symbol}`
          );
        } else {
          logger.info(
            `${pairConfig.name} | Executing arbitrage …`
          );
          const result = await executeArbitrage(signer, config, opportunity);

          if (!result.success) {
            logger.error(
              `${pairConfig.name} | Trade failed: ${result.error}`
            );
          }
        }
      } catch (err) {
        logger.error(
          `Error processing pair ${pairConfig.name}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    logger.info(
      `└── Sleeping ${config.pollIntervalMs} ms before next iteration …`
    );
    await sleep(config.pollIntervalMs);
  }
}

// Run
main().catch((err) => {
  logger.error("Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
