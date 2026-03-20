/**
 * Simple, zero-dependency logger.
 *
 * Every message includes an ISO timestamp.  Colour codes are ANSI and work in
 * any modern terminal.  They are automatically stripped when the output is
 * redirected to a file.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";

function ts(): string {
  return new Date().toISOString();
}

export const logger = {
  info(message: string, ...args: unknown[]): void {
    console.log(
      `${DIM}[${ts()}]${RESET} ${BLUE}INFO ${RESET}  ${message}`,
      ...args
    );
  },

  success(message: string, ...args: unknown[]): void {
    console.log(
      `${DIM}[${ts()}]${RESET} ${GREEN}${BOLD}OK   ${RESET} ${message}`,
      ...args
    );
  },

  warn(message: string, ...args: unknown[]): void {
    console.log(
      `${DIM}[${ts()}]${RESET} ${YELLOW}WARN ${RESET}  ${message}`,
      ...args
    );
  },

  error(message: string, ...args: unknown[]): void {
    console.error(
      `${DIM}[${ts()}]${RESET} ${RED}ERROR${RESET} ${message}`,
      ...args
    );
  },

  /** Log the current price read from a pool. */
  price(pairName: string, poolLabel: string, priceAInB: number): void {
    console.log(
      `${DIM}[${ts()}]${RESET} ${CYAN}PRICE${RESET} ` +
        `${BOLD}${pairName}${RESET} | ${poolLabel}: ` +
        `${WHITE}${priceAInB.toFixed(8)}${RESET}`
    );
  },

  /** Log a detected arbitrage opportunity. */
  opportunity(
    pairName: string,
    diffPercent: number,
    estimatedProfitA: number,
    symbolA: string
  ): void {
    console.log(
      `${DIM}[${ts()}]${RESET} ${GREEN}${BOLD}OPPORTUNITY${RESET} ` +
        `${BOLD}${pairName}${RESET} | ` +
        `Diff: ${GREEN}${diffPercent.toFixed(4)}%${RESET} | ` +
        `Est. profit: ${GREEN}${estimatedProfitA.toFixed(4)} ${symbolA}${RESET}`
    );
  },

  /** Log a successfully executed trade. */
  trade(
    pairName: string,
    txHash1: string,
    txHash2: string,
    profit: number,
    symbolA: string,
    gasUsed: string
  ): void {
    console.log(
      `${DIM}[${ts()}]${RESET} ${GREEN}${BOLD}TRADE${RESET} ` +
        `${BOLD}${pairName}${RESET} | ` +
        `tx1: ${CYAN}${txHash1}${RESET} | ` +
        `tx2: ${CYAN}${txHash2}${RESET} | ` +
        `Profit: ${GREEN}${profit.toFixed(4)} ${symbolA}${RESET} | ` +
        `Gas: ${gasUsed}`
    );
  },

  /** Log what the bot *would* have done in dry-run mode. */
  dryRun(pairName: string, action: string, details: string): void {
    console.log(
      `${DIM}[${ts()}]${RESET} ${YELLOW}${BOLD}DRY-RUN${RESET} ` +
        `${BOLD}${pairName}${RESET} | ${action}: ${details}`
    );
  },
};
