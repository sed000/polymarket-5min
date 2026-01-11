import type { BacktestResult, BacktestTrade, OptimizationResult, PerformanceMetrics } from "./types";

/**
 * Format a number as currency
 */
function formatCurrency(value: number): string {
  const sign = value >= 0 ? "" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

/**
 * Format a number as percentage
 */
function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Format a date for display
 */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms: number): string {
  if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  }
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Print a horizontal line
 */
function printLine(char: string = "=", length: number = 60): void {
  console.log(char.repeat(length));
}

/**
 * Print backtest results to console
 */
export function printBacktestReport(result: BacktestResult): void {
  console.log("\n");
  printLine("=");
  console.log("                BACKTEST RESULTS");
  printLine("=");

  // Period
  console.log(`\nPeriod: ${formatDate(result.config.startDate)} to ${formatDate(result.config.endDate)}`);
  console.log(`Starting Balance: ${formatCurrency(result.config.startingBalance)}`);
  console.log(`Risk Mode: ${result.config.riskMode}`);
  if (result.config.compoundLimit > 0) {
    console.log(`Compound Limit: ${formatCurrency(result.config.compoundLimit)} (reset to ${formatCurrency(result.config.baseBalance)})`);
  }

  // Configuration
  console.log("\n--- Configuration ---");
  console.log(`  Entry Range: ${formatCurrency(result.config.entryThreshold)} - ${formatCurrency(result.config.maxEntryPrice)}`);
  console.log(`  Profit Target: ${formatCurrency(result.config.profitTarget)}`);
  console.log(`  Stop Loss: ${formatCurrency(result.config.stopLoss)}`);
  console.log(`  Stop Loss Delay: ${formatDuration(result.config.stopLossDelayMs)}`);
  console.log(`  Max Spread: ${formatCurrency(result.config.maxSpread)}`);
  console.log(`  Time Window: ${formatDuration(result.config.timeWindowMs)}`);

  // Performance Summary
  console.log("\n--- Performance ---");
  console.log(`  Total Trades: ${result.metrics.totalTrades}`);
  console.log(`  Win/Loss: ${result.metrics.wins}/${result.metrics.losses}`);
  console.log(`  Win Rate: ${formatPercent(result.metrics.winRate)}`);
  console.log(`  Total PnL: ${formatCurrency(result.metrics.totalPnL)}`);
  console.log(`  Return: ${formatPercent(result.metrics.returnOnCapital)}`);
  console.log(`  Final Balance: ${formatCurrency(result.finalBalance)}`);
  if (result.savedProfit > 0) {
    console.log(`  Saved Profit: ${formatCurrency(result.savedProfit)}`);
    console.log(`  Total Value: ${formatCurrency(result.finalBalance + result.savedProfit)}`);
  }

  // Risk Metrics
  console.log("\n--- Risk Metrics ---");
  console.log(`  Max Drawdown: ${formatCurrency(result.metrics.maxDrawdown)} (${formatPercent(result.metrics.maxDrawdownPercent)})`);
  console.log(`  Sharpe Ratio: ${result.metrics.sharpeRatio.toFixed(2)}`);
  console.log(`  Profit Factor: ${result.metrics.profitFactor === Infinity ? "∞" : result.metrics.profitFactor.toFixed(2)}`);
  console.log(`  Expectancy: ${formatCurrency(result.metrics.expectancy)}`);

  // Trade Analysis
  console.log("\n--- Trade Analysis ---");
  console.log(`  Avg Win: ${formatCurrency(result.metrics.avgWin)}`);
  console.log(`  Avg Loss: ${formatCurrency(result.metrics.avgLoss)}`);
  console.log(`  Avg Trade: ${formatCurrency(result.metrics.avgTradeReturn)}`);
  console.log(`  Max Consecutive Wins: ${result.metrics.maxConsecutiveWins}`);
  console.log(`  Max Consecutive Losses: ${result.metrics.maxConsecutiveLosses}`);

  // Exit Breakdown
  const profitTargetExits = result.trades.filter(t => t.exitReason === "PROFIT_TARGET").length;
  const stopLossExits = result.trades.filter(t => t.exitReason === "STOP_LOSS").length;
  const resolvedExits = result.trades.filter(t => t.exitReason === "MARKET_RESOLVED").length;

  console.log("\n--- Exit Breakdown ---");
  console.log(`  Profit Target: ${profitTargetExits} (${formatPercent(result.metrics.totalTrades > 0 ? profitTargetExits / result.metrics.totalTrades : 0)})`);
  console.log(`  Stop Loss: ${stopLossExits} (${formatPercent(result.metrics.totalTrades > 0 ? stopLossExits / result.metrics.totalTrades : 0)})`);
  console.log(`  Market Resolved: ${resolvedExits} (${formatPercent(result.metrics.totalTrades > 0 ? resolvedExits / result.metrics.totalTrades : 0)})`);

  printLine("=");
  console.log("");
}

/**
 * Print optimization results table
 */
export function printOptimizationTable(
  results: OptimizationResult[],
  limit: number = 10
): void {
  console.log("\n");
  printLine("=");
  console.log("              TOP OPTIMIZATION RESULTS");
  printLine("=");

  const topResults = results.slice(0, limit);

  // Header
  console.log("\nRank | Entry    | Stop  | Delay | Win%  | PnL      | Drawdown | Sharpe");
  console.log("-----+----------+-------+-------+-------+----------+----------+-------");

  for (const r of topResults) {
    const entry = `$${r.config.entryThreshold.toFixed(2)}-${r.config.maxEntryPrice.toFixed(2)}`;
    const stop = `$${r.config.stopLoss.toFixed(2)}`;
    const delay = `${(r.config.stopLossDelayMs / 1000).toFixed(0)}s`;
    const winRate = `${(r.metrics.winRate * 100).toFixed(1)}%`;
    const pnl = formatCurrency(r.metrics.totalPnL);
    const drawdown = formatPercent(r.metrics.maxDrawdownPercent);
    const sharpe = r.metrics.sharpeRatio.toFixed(2);

    console.log(
      `${r.rank.toString().padStart(4)} | ${entry.padEnd(8)} | ${stop.padEnd(5)} | ${delay.padEnd(5)} | ${winRate.padEnd(5)} | ${pnl.padEnd(8)} | ${drawdown.padEnd(8)} | ${sharpe}`
    );
  }

  console.log("");
  printLine("=");

  // Best config details
  if (topResults.length > 0) {
    const best = topResults[0];
    console.log("\n--- Best Configuration ---");
    console.log(`  Entry Threshold: ${formatCurrency(best.config.entryThreshold)}`);
    console.log(`  Max Entry Price: ${formatCurrency(best.config.maxEntryPrice)}`);
    console.log(`  Stop Loss: ${formatCurrency(best.config.stopLoss)}`);
    console.log(`  Stop Loss Delay: ${formatDuration(best.config.stopLossDelayMs)}`);
    console.log(`  Max Spread: ${formatCurrency(best.config.maxSpread)}`);
    console.log(`  Time Window: ${formatDuration(best.config.timeWindowMs)}`);
    console.log("");
  }
}

/**
 * Print comparison of two configs
 */
export function printComparisonTable(
  comparisons: { label: string; result: BacktestResult }[]
): void {
  console.log("\n");
  printLine("=");
  console.log("              CONFIGURATION COMPARISON");
  printLine("=");

  // Header
  const labels = comparisons.map(c => c.label);
  console.log(`\nMetric              | ${labels.map(l => l.padEnd(15)).join(" | ")}`);
  console.log(`--------------------+${labels.map(() => "-".repeat(17)).join("+")}`)

  const metrics: Array<{ name: string; key: keyof PerformanceMetrics; format: (v: number) => string }> = [
    { name: "Total Trades", key: "totalTrades", format: v => v.toString() },
    { name: "Win Rate", key: "winRate", format: formatPercent },
    { name: "Total PnL", key: "totalPnL", format: formatCurrency },
    { name: "Return", key: "returnOnCapital", format: formatPercent },
    { name: "Max Drawdown", key: "maxDrawdownPercent", format: formatPercent },
    { name: "Sharpe Ratio", key: "sharpeRatio", format: v => v.toFixed(2) },
    { name: "Profit Factor", key: "profitFactor", format: v => v === Infinity ? "∞" : v.toFixed(2) },
    { name: "Avg Win", key: "avgWin", format: formatCurrency },
    { name: "Avg Loss", key: "avgLoss", format: formatCurrency },
  ];

  for (const m of metrics) {
    const values = comparisons.map(c => m.format(c.result.metrics[m.key] as number));
    console.log(`${m.name.padEnd(19)} | ${values.map(v => v.padEnd(15)).join(" | ")}`);
  }

  printLine("=");
  console.log("");
}

/**
 * Print recent trades
 */
export function printTrades(trades: BacktestTrade[], limit: number = 20): void {
  console.log("\n");
  printLine("-");
  console.log("                    TRADE LOG");
  printLine("-");

  const recentTrades = trades.slice(-limit);

  console.log("\nDate       | Side | Entry  | Exit   | Reason          | PnL");
  console.log("-----------+------+--------+--------+-----------------+--------");

  for (const t of recentTrades) {
    const date = new Date(t.entryTimestamp).toISOString().slice(0, 10);
    const side = t.side.padEnd(4);
    const entry = `$${t.entryPrice.toFixed(2)}`;
    const exit = `$${t.exitPrice.toFixed(2)}`;
    const reason = t.exitReason.padEnd(15);
    const pnl = formatCurrency(t.pnl);

    console.log(`${date} | ${side} | ${entry} | ${exit} | ${reason} | ${pnl}`);
  }

  printLine("-");
  console.log("");
}

/**
 * Export trades to CSV format
 */
export function tradesToCSV(trades: BacktestTrade[]): string {
  const headers = [
    "market_slug",
    "token_id",
    "side",
    "entry_price",
    "exit_price",
    "shares",
    "entry_timestamp",
    "exit_timestamp",
    "exit_reason",
    "pnl",
  ];

  const rows = trades.map(t => [
    t.marketSlug,
    t.tokenId,
    t.side,
    t.entryPrice.toFixed(4),
    t.exitPrice.toFixed(4),
    t.shares.toFixed(4),
    new Date(t.entryTimestamp).toISOString(),
    new Date(t.exitTimestamp).toISOString(),
    t.exitReason,
    t.pnl.toFixed(4),
  ]);

  return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
}

/**
 * Export backtest result to JSON
 */
export function resultToJSON(result: BacktestResult): string {
  return JSON.stringify(
    {
      config: {
        ...result.config,
        startDate: result.config.startDate.toISOString(),
        endDate: result.config.endDate.toISOString(),
      },
      metrics: result.metrics,
      tradeCount: result.trades.length,
      trades: result.trades.map(t => ({
        ...t,
        entryTimestamp: new Date(t.entryTimestamp).toISOString(),
        exitTimestamp: new Date(t.exitTimestamp).toISOString(),
      })),
    },
    null,
    2
  );
}

/**
 * Print a progress bar
 */
export function printProgress(current: number, total: number, width: number = 40): void {
  const percent = current / total;
  const filled = Math.round(width * percent);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  process.stdout.write(`\r[${bar}] ${(percent * 100).toFixed(1)}% (${current}/${total})`);
}

/**
 * Clear progress line
 */
export function clearProgress(): void {
  process.stdout.write("\r" + " ".repeat(80) + "\r");
}
