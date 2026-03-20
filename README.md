# botv2 – Uniswap V3 Arbitrage Bot (Polygon PoS)

A TypeScript/Node.js bot that monitors two fee-tier pools of the same token
pair on Uniswap V3 (Polygon mainnet) and executes simple 2-token arbitrage
trades when the on-chain prices diverge beyond a configurable threshold.

---

## How it works

1. **Two-pool arbitrage** – Each configured pair has two Uniswap V3 pools
   (e.g. USDC/WETH 0.05% and USDC/WETH 0.30%).  The bot reads `slot0` from
   both pools every _N_ seconds to derive the current price.
2. **Opportunity detection** – If the price difference exceeds
   `MIN_PROFIT_THRESHOLD_PERCENT`, the bot calculates the expected gross
   profit (pool fees deducted, gas _not_ deducted at this stage).
3. **Trade execution** – Two sequential `exactInputSingle` swaps via the
   official Uniswap V3 SwapRouter:
   - Swap tokenA → tokenB on the cheaper pool.
   - Swap tokenB → tokenA on the more expensive pool.
4. **Dry-run mode** – When `DRY_RUN=true` (the default) the bot logs every
   opportunity and what it _would_ have done but never sends a real
   transaction.

### Project structure

```
src/
├── config/      # Loads and validates all settings from .env
├── onchain/     # Reads pool prices; detects arbitrage opportunities
├── trade/       # Approves tokens and executes swaps
├── utils/
│   ├── logger.ts   # Timestamped, colour-coded console logger
│   └── math.ts     # sqrtPriceX96 → price, token amount helpers, slippage
└── main.ts      # Main polling loop
```

---

## Prerequisites

- **Node.js ≥ 18**
- A **Polygon RPC endpoint** – Infura, Alchemy, or a public RPC such as
  `https://polygon-rpc.com`
- A **dedicated wallet** funded with:
  - MATIC for gas
  - The tokenA amount you want to trade (e.g. USDC)

> ⚠️ **Never use your main wallet.** Create a fresh wallet just for the bot.

---

## Installation

```bash
git clone <repo-url>
cd botv2
npm install
```

---

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### Minimum required variables

| Variable | Description |
|---|---|
| `RPC_URL` | Polygon RPC endpoint |
| `PRIVATE_KEY` | Bot wallet private key (hex, with or without `0x`) |
| `ACTIVE_PAIRS` | Comma-separated pair names, e.g. `USDC_WETH` |
| `<PAIR>_TOKEN_A_*` | Address, symbol, decimals of the starting token |
| `<PAIR>_TOKEN_B_*` | Address, symbol, decimals of the target token |
| `<PAIR>_POOL_A_*` | Address and fee of the first pool |
| `<PAIR>_POOL_B_*` | Address and fee of the second pool |

### Optional variables (with defaults)

| Variable | Default | Description |
|---|---|---|
| `UNISWAP_ROUTER_ADDRESS` | `0xE592427A...` | Uniswap V3 SwapRouter on Polygon |
| `<PAIR>_TRADE_SIZE` | `100` | tokenA per trade (human-readable) |
| `MIN_PROFIT_THRESHOLD_PERCENT` | `0.5` | Minimum % spread to trigger a trade |
| `MAX_SLIPPAGE_PERCENT` | `0.5` | Maximum slippage per swap |
| `POLL_INTERVAL_MS` | `5000` | Polling interval in milliseconds |
| `DRY_RUN` | `true` | `true` = simulate only, `false` = live |

---

## Example configs

### USDC / WETH on Polygon

```env
RPC_URL=https://polygon-rpc.com
PRIVATE_KEY=0xYOUR_KEY

ACTIVE_PAIRS=USDC_WETH

USDC_WETH_TOKEN_A_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
USDC_WETH_TOKEN_A_SYMBOL=USDC
USDC_WETH_TOKEN_A_DECIMALS=6

USDC_WETH_TOKEN_B_ADDRESS=0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619
USDC_WETH_TOKEN_B_SYMBOL=WETH
USDC_WETH_TOKEN_B_DECIMALS=18

# 0.05% pool
USDC_WETH_POOL_A_ADDRESS=0x45dDa9cb7c25131DF268515131f647d726f50608
USDC_WETH_POOL_A_FEE=500

# 0.30% pool
USDC_WETH_POOL_B_ADDRESS=0x88f3C15523544835fF6c738DDb30995339AD57d6
USDC_WETH_POOL_B_FEE=3000

USDC_WETH_TRADE_SIZE=100
MIN_PROFIT_THRESHOLD_PERCENT=0.5
MAX_SLIPPAGE_PERCENT=0.5
POLL_INTERVAL_MS=5000
DRY_RUN=true
```

### USDC / WMATIC on Polygon

```env
ACTIVE_PAIRS=USDC_WMATIC

USDC_WMATIC_TOKEN_A_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
USDC_WMATIC_TOKEN_A_SYMBOL=USDC
USDC_WMATIC_TOKEN_A_DECIMALS=6

USDC_WMATIC_TOKEN_B_ADDRESS=0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270
USDC_WMATIC_TOKEN_B_SYMBOL=WMATIC
USDC_WMATIC_TOKEN_B_DECIMALS=18

# 0.05% pool
USDC_WMATIC_POOL_A_ADDRESS=0xA374094527e1673A86dE625aa59517c5dE346d32
USDC_WMATIC_POOL_A_FEE=500

# 0.30% pool
USDC_WMATIC_POOL_B_ADDRESS=0x0e44cEb592AcFC5D3F09D996302eB4C499ff8c10
USDC_WMATIC_POOL_B_FEE=3000

USDC_WMATIC_TRADE_SIZE=100
DRY_RUN=true
```

---

## Running the bot

### Dry-run mode (safe – no real transactions)

```bash
npm run dev
# or, after building:
npm run build && npm start
```

`DRY_RUN` defaults to `true` in `.env.example`.  The bot logs opportunities
like:

```
[2024-...] DRY-RUN USDC_WETH | Would trade: Buy WETH in Pool A @ 0.00033452,
  sell in Pool B @ 0.00033018 | Est. profit: 0.1342 USDC
```

### Live mode (real trades)

Set `DRY_RUN=false` in your `.env`, then:

```bash
npm run build && npm start
```

> ⚠️ Only go live after thorough dry-run testing. The bot does **not** use
> flash loans and requires real token balances.

---

## Supported tokens on Polygon

| Token | Address |
|---|---|
| USDC (bridged) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| WETH | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` |
| WMATIC | `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` |
| WBTC | `0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6` |

Add any pair to `ACTIVE_PAIRS` and supply the corresponding env vars.

---

## Security notes

- Store `.env` securely; never commit it.
- Use a dedicated bot wallet with minimal funds.
- Review the slippage and profit threshold before enabling live mode.
- This code is provided for educational purposes.  Use at your own risk.

---

## License

MIT