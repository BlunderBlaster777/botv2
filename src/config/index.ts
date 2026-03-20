import dotenv from "dotenv";
import { ethers } from "ethers";
import path from "path";

// Load .env from the project root (wherever the process is started from)
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** Minimal description of an ERC-20 token. */
export interface TokenConfig {
  address: string;
  symbol: string;
  decimals: number;
}

/** A Uniswap V3 pool (address + fee tier). */
export interface PoolConfig {
  address: string;
  /** Fee tier in hundredths of a bip: 500 = 0.05%, 3000 = 0.3%, 10000 = 1% */
  fee: number;
}

/**
 * Configuration for one trading pair.
 *
 * The bot monitors two pools of the same token pair but at different fee tiers.
 * When the price diverges above the threshold it will:
 *   1. Swap tokenA → tokenB on the cheaper pool (poolBuy)
 *   2. Swap tokenB → tokenA on the more expensive pool (poolSell)
 */
export interface PairConfig {
  /** Human-readable label, e.g. "USDC_WETH" */
  name: string;
  /** Starting token (e.g. USDC).  Trade size is specified in units of tokenA. */
  tokenA: TokenConfig;
  /** Target token (e.g. WETH). */
  tokenB: TokenConfig;
  /** First pool to compare (e.g. 0.05% fee tier). */
  poolA: PoolConfig;
  /** Second pool to compare (e.g. 0.30% fee tier). */
  poolB: PoolConfig;
  /** Amount of tokenA to use per trade, in human-readable units (e.g. "100"). */
  tradeSizeA: string;
}

/** Top-level bot configuration. */
export interface BotConfig {
  rpcUrl: string;
  privateKey: string;
  walletAddress: string;
  /** Uniswap V3 SwapRouter address */
  uniswapRouterAddress: string;
  /** Minimum price-difference (%) between pools to trigger a trade */
  minProfitThresholdPercent: number;
  /** Maximum slippage (%) accepted per swap */
  maxSlippagePercent: number;
  /** How often to poll prices in milliseconds */
  pollIntervalMs: number;
  /**
   * When true the bot logs opportunities but never sends real transactions.
   * Always start with dryRun=true to verify behaviour before going live.
   */
  dryRun: boolean;
  pairs: PairConfig[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}\n` +
        `Copy .env.example to .env and fill in your values.`
    );
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

/**
 * Parse an integer from an environment variable value.
 * Throws a clear error if the value is not a valid integer.
 */
function requireIntEnv(key: string): number {
  const raw = requireEnv(key);
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(
      `Environment variable ${key} must be an integer, got "${raw}"`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Reads all configuration from environment variables.
 * Throws a descriptive error if a required variable is missing.
 */
export function loadConfig(): BotConfig {
  const privateKey = requireEnv("PRIVATE_KEY");

  // Derive wallet address from private key so callers don't need to supply it
  const wallet = new ethers.Wallet(privateKey);

  // ACTIVE_PAIRS is a comma-separated list of pair names.
  // Each name maps to a group of env vars with that name as the prefix.
  const activePairNames = optionalEnv("ACTIVE_PAIRS", "USDC_WETH")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const pairs: PairConfig[] = activePairNames.map((pairName) => {
    const p = pairName.toUpperCase();

    return {
      name: pairName,
      tokenA: {
        address: requireEnv(`${p}_TOKEN_A_ADDRESS`),
        symbol: requireEnv(`${p}_TOKEN_A_SYMBOL`),
        decimals: requireIntEnv(`${p}_TOKEN_A_DECIMALS`),
      },
      tokenB: {
        address: requireEnv(`${p}_TOKEN_B_ADDRESS`),
        symbol: requireEnv(`${p}_TOKEN_B_SYMBOL`),
        decimals: requireIntEnv(`${p}_TOKEN_B_DECIMALS`),
      },
      poolA: {
        address: requireEnv(`${p}_POOL_A_ADDRESS`),
        fee: requireIntEnv(`${p}_POOL_A_FEE`),
      },
      poolB: {
        address: requireEnv(`${p}_POOL_B_ADDRESS`),
        fee: requireIntEnv(`${p}_POOL_B_FEE`),
      },
      tradeSizeA: optionalEnv(`${p}_TRADE_SIZE`, "100"),
    };
  });

  return {
    rpcUrl: requireEnv("RPC_URL"),
    privateKey,
    walletAddress: wallet.address,
    uniswapRouterAddress: optionalEnv(
      "UNISWAP_ROUTER_ADDRESS",
      "0xE592427A0AEce92De3Edee1F18E0157C05861564"
    ),
    minProfitThresholdPercent: parseFloat(
      optionalEnv("MIN_PROFIT_THRESHOLD_PERCENT", "0.5")
    ),
    maxSlippagePercent: parseFloat(optionalEnv("MAX_SLIPPAGE_PERCENT", "0.5")),
    pollIntervalMs: parseInt(optionalEnv("POLL_INTERVAL_MS", "5000"), 10),
    dryRun: optionalEnv("DRY_RUN", "true").toLowerCase() === "true",
    pairs,
  };
}
