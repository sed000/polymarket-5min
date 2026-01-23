#!/usr/bin/env bun
import { parseArgs } from "util";
import type { BacktestConfig } from "./types";
import { DEFAULT_BACKTEST_CONFIG, SUPER_RISK_CONFIG, SAFE_CONFIG, DYNAMIC_RISK_CONFIG } from "./types";
import type { RiskMode } from "../bot";
import { fetchHistoricalDataset, loadCachedDataset, getCacheStats } from "./data-fetcher";
import { runBacktest, BacktestEngine } from "./engine";
import {
  runOptimization,
  getQuickOptimizationRanges,
  getDetailedOptimizationRanges,
  compareConfigs,
} from "./optimizer";
import { runGeneticOptimization } from "./genetic";
import { printGeneticProgress, clearGeneticProgress, printGeneticReport, geneticResultToJSON, exportConfigForEnv } from "./genetic/reporter";
import {
  printBacktestReport,
  printOptimizationTable,
  printComparisonTable,
  printTrades,
  printProgress,
  clearProgress,
  tradesToCSV,
  resultToJSON,
} from "./reporter";
import {
  initBacktestDatabase,
  insertBacktestRun,
  updateBacktestRunStatus,
  insertBacktestTrade,
  listBacktestRuns,
  getBacktestTrades,
  clearBacktestData,
  clearHistoricalData,
} from "../db";
import { writeFileSync } from "fs";

const HELP = `
Polymarket BTC Bot Backtester

USAGE:
  bun run src/backtest/index.ts <command> [options]

COMMANDS:
  run       Run a backtest with specified configuration
  fetch     Fetch historical market data from Polymarket API
  optimize  Find optimal parameters through grid search
  genetic   Find optimal parameters using genetic algorithm (recommended)
  compare   Compare normal vs super-risk mode
  history   View past backtest runs
  stats     Show cached data statistics
  clear     Clear cached data

OPTIONS:
  --days <n>          Number of days to backtest (default: 7)
  --start <date>      Start date (YYYY-MM-DD)
  --end <date>        End date (YYYY-MM-DD)
  --entry <price>     Entry threshold (default: 0.95)
  --max-entry <price> Max entry price (default: 0.98)
  --stop <price>      Stop loss threshold (default: 0.80)
  --spread <price>    Max spread (default: 0.03)
  --window <ms>       Time window in ms (default: 300000)
  --balance <amount>  Starting balance (default: 100)
  --mode <mode>       Risk mode: normal, super-risk, dynamic-risk, or safe
  --quick             Use quick optimization (fewer combinations)
  --force             Force re-fetch data even if cached
  --export <file>     Export results to file (csv or json)
  --limit <n>         Limit output rows

GENETIC ALGORITHM OPTIONS:
  --population <n>    Population size (default: 50)
  --generations <n>   Max generations (default: 100)
  --mutation <rate>   Mutation rate 0-1 (default: 0.15)
  --train-split <r>   Training data ratio 0-1 (default: 0.7)
  --elite <n>         Elite count to preserve (default: 5)

EXAMPLES:
  # Run backtest with default config for last 7 days
  bun run src/backtest/index.ts run --days 7

  # Run backtest with custom parameters
  bun run src/backtest/index.ts run --entry 0.90 --stop 0.60 --days 14

  # Fetch historical data
  bun run src/backtest/index.ts fetch --days 30

  # Run parameter optimization (grid search)
  bun run src/backtest/index.ts optimize --days 14

  # Run genetic algorithm optimization (recommended)
  bun run src/backtest/index.ts genetic --days 14

  # Run genetic with custom settings
  bun run src/backtest/index.ts genetic --days 30 --population 100 --generations 200

  # Compare risk modes
  bun run src/backtest/index.ts compare --days 7
`;

// Parse command line arguments
function parseArguments() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      days: { type: "string", default: "7" },
      start: { type: "string" },
      end: { type: "string" },
      entry: { type: "string" },
      "max-entry": { type: "string" },
      stop: { type: "string" },
      delay: { type: "string" },
      spread: { type: "string" },
      window: { type: "string" },
      balance: { type: "string" },
      mode: { type: "string" },
      quick: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      export: { type: "string" },
      limit: { type: "string", default: "10" },
      help: { type: "boolean", short: "h", default: false },
      // Genetic algorithm options
      population: { type: "string", default: "50" },
      generations: { type: "string", default: "100" },
      mutation: { type: "string", default: "0.15" },
      "train-split": { type: "string", default: "0.7" },
      elite: { type: "string", default: "5" },
    },
    allowPositionals: true,
  });

  return { values, positionals };
}

// Load backtest config from environment
function getEnvConfig() {
  return {
    mode: process.env.BACKTEST_MODE || "normal",
    entryThreshold: parseFloat(process.env.BACKTEST_ENTRY_THRESHOLD || "0.95"),
    maxEntryPrice: parseFloat(process.env.BACKTEST_MAX_ENTRY_PRICE || "0.98"),
    stopLoss: parseFloat(process.env.BACKTEST_STOP_LOSS || "0.80"),
    profitTarget: parseFloat(process.env.BACKTEST_PROFIT_TARGET || "0.99"),
    maxSpread: parseFloat(process.env.BACKTEST_MAX_SPREAD || "0.03"),
    timeWindowMs: parseInt(process.env.BACKTEST_TIME_WINDOW_MINS || "5", 10) * 60 * 1000,
    startingBalance: parseFloat(process.env.BACKTEST_STARTING_BALANCE || "100"),
    defaultDays: parseInt(process.env.BACKTEST_DAYS || "7", 10),
    compoundLimit: parseFloat(process.env.BACKTEST_COMPOUND_LIMIT || "0"),
    baseBalance: parseFloat(process.env.BACKTEST_BASE_BALANCE || "10"),
  };
}

// Calculate date range
function getDateRange(args: ReturnType<typeof parseArguments>["values"]): { startDate: Date; endDate: Date } {
  const envConfig = getEnvConfig();
  const endDate = args.end ? new Date(args.end) : new Date();
  const days = parseInt(args.days || String(envConfig.defaultDays), 10);
  const startDate = args.start
    ? new Date(args.start)
    : new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  return { startDate, endDate };
}

// Load cached data or fetch from API
async function loadOrFetchMarkets(startDate: Date, endDate: Date): Promise<ReturnType<typeof loadCachedDataset> | null> {
  console.log("Loading historical data...");
  let markets = await loadCachedDataset(startDate, endDate);

  if (markets.length === 0) {
    console.log("\nNo cached data found. Fetching from API...");
    markets = await fetchHistoricalDataset(startDate, endDate, {
      onProgress: (p) => printProgress(p.current, p.total),
    });
    clearProgress();

    if (markets.length === 0) {
      console.log("No historical data available for this period.");
      return null;
    }
  }

  return markets;
}

/**
 * Validate backtest configuration
 * Ensures parameters are within valid ranges and logically consistent
 */
function validateBacktestConfig(config: BacktestConfig): void {
  const errors: string[] = [];

  // Range validations
  if (config.entryThreshold < 0.01 || config.entryThreshold > 0.99) {
    errors.push(`entryThreshold must be between 0.01 and 0.99 (got ${config.entryThreshold})`);
  }
  if (config.maxEntryPrice < 0.01 || config.maxEntryPrice > 0.99) {
    errors.push(`maxEntryPrice must be between 0.01 and 0.99 (got ${config.maxEntryPrice})`);
  }
  if (config.stopLoss < 0.01 || config.stopLoss > 0.99) {
    errors.push(`stopLoss must be between 0.01 and 0.99 (got ${config.stopLoss})`);
  }
  if (config.profitTarget < 0.01 || config.profitTarget > 0.99) {
    errors.push(`profitTarget must be between 0.01 and 0.99 (got ${config.profitTarget})`);
  }
  if (config.maxSpread < 0 || config.maxSpread > 0.50) {
    errors.push(`maxSpread must be between 0 and 0.50 (got ${config.maxSpread})`);
  }
  if (config.slippage < 0 || config.slippage > 0.10) {
    errors.push(`slippage must be between 0 and 0.10 (got ${config.slippage})`);
  }
  if (config.startingBalance <= 0) {
    errors.push(`startingBalance must be positive (got ${config.startingBalance})`);
  }

  // Logical validations
  if (config.entryThreshold >= config.maxEntryPrice) {
    errors.push(`entryThreshold (${config.entryThreshold}) must be < maxEntryPrice (${config.maxEntryPrice})`);
  }
  if (config.stopLoss >= config.entryThreshold) {
    errors.push(`stopLoss (${config.stopLoss}) must be < entryThreshold (${config.entryThreshold})`);
  }
  if (config.maxEntryPrice >= config.profitTarget) {
    errors.push(`maxEntryPrice (${config.maxEntryPrice}) must be < profitTarget (${config.profitTarget})`);
  }

  // Risk mode validation
  const validModes: RiskMode[] = ["normal", "super-risk", "dynamic-risk", "safe"];
  if (!validModes.includes(config.riskMode)) {
    errors.push(`riskMode must be one of: ${validModes.join(", ")} (got ${config.riskMode})`);
  }

  // Time window validation
  if (config.timeWindowMs < 30000 || config.timeWindowMs > 900000) {
    errors.push(`timeWindowMs must be between 30000 (30s) and 900000 (15m) (got ${config.timeWindowMs})`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid backtest configuration:\n  - ${errors.join("\n  - ")}`);
  }
}

/**
 * Get preset config overrides for a risk mode
 */
function getPresetForMode(mode: RiskMode): Partial<BacktestConfig> {
  switch (mode) {
    case "super-risk":
      return SUPER_RISK_CONFIG;
    case "dynamic-risk":
      return DYNAMIC_RISK_CONFIG;
    case "safe":
      return SAFE_CONFIG;
    case "normal":
    default:
      return {};
  }
}

// Build config from arguments (env config is the base, CLI args override)
function buildConfig(args: ReturnType<typeof parseArguments>["values"], startDate: Date, endDate: Date): BacktestConfig {
  const envConfig = getEnvConfig();
  const mode = (args.mode || envConfig.mode) as RiskMode;

  // Get preset overrides for the risk mode
  const modePreset = getPresetForMode(mode);

  // Build config: defaults < mode preset < env config < CLI args
  const config: BacktestConfig = {
    // Start with defaults
    ...DEFAULT_BACKTEST_CONFIG,
    // Apply mode preset
    ...modePreset,
    // Apply env/CLI values
    entryThreshold: args.entry ? parseFloat(args.entry) : (modePreset.entryThreshold ?? envConfig.entryThreshold),
    maxEntryPrice: args["max-entry"] ? parseFloat(args["max-entry"]) : (modePreset.maxEntryPrice ?? envConfig.maxEntryPrice),
    stopLoss: args.stop ? parseFloat(args.stop) : (modePreset.stopLoss ?? envConfig.stopLoss),
    maxSpread: args.spread ? parseFloat(args.spread) : (modePreset.maxSpread ?? envConfig.maxSpread),
    timeWindowMs: args.window ? parseInt(args.window, 10) : (modePreset.timeWindowMs ?? envConfig.timeWindowMs),
    profitTarget: modePreset.profitTarget ?? envConfig.profitTarget,
    startingBalance: args.balance ? parseFloat(args.balance) : envConfig.startingBalance,
    slippage: DEFAULT_BACKTEST_CONFIG.slippage,
    compoundLimit: envConfig.compoundLimit,
    baseBalance: envConfig.baseBalance,
    riskMode: mode,
    startDate,
    endDate,
  };

  // Validate the config
  validateBacktestConfig(config);

  return config;
}

// Command: run
async function commandRun(args: ReturnType<typeof parseArguments>["values"]) {
  const { startDate, endDate } = getDateRange(args);
  const config = buildConfig(args, startDate, endDate);

  const markets = await loadOrFetchMarkets(startDate, endDate);
  if (!markets) return;

  console.log(`\nRunning backtest on ${markets.length} markets...`);

  // Run backtest
  initBacktestDatabase();
  const result = runBacktest(config, markets);

  // Save to database
  const runId = insertBacktestRun(config, markets.length);
  for (const trade of result.trades) {
    insertBacktestTrade(runId, trade);
  }
  updateBacktestRunStatus(runId, "COMPLETED");

  // Print results
  printBacktestReport(result);

  // Show trades
  if (result.trades.length > 0) {
    printTrades(result.trades, parseInt(args.limit || "10", 10));
  }

  // Export if requested
  if (args.export) {
    const ext = args.export.split(".").pop()?.toLowerCase();
    if (ext === "csv") {
      writeFileSync(args.export, tradesToCSV(result.trades));
      console.log(`Trades exported to ${args.export}`);
    } else {
      writeFileSync(args.export, resultToJSON(result));
      console.log(`Results exported to ${args.export}`);
    }
  }
}

// Command: fetch
async function commandFetch(args: ReturnType<typeof parseArguments>["values"]) {
  const { startDate, endDate } = getDateRange(args);

  console.log(`Fetching historical data from ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}...`);

  const markets = await fetchHistoricalDataset(startDate, endDate, {
    forceRefetch: args.force,
    onProgress: (p) => {
      printProgress(p.current, p.total);
    },
  });

  clearProgress();
  console.log(`\nFetched ${markets.length} markets with price data.`);
}

// Command: optimize
async function commandOptimize(args: ReturnType<typeof parseArguments>["values"]) {
  const { startDate, endDate } = getDateRange(args);

  const markets = await loadOrFetchMarkets(startDate, endDate);
  if (!markets) return;

  console.log(`\nOptimizing on ${markets.length} markets...`);

  const ranges = args.quick ? getQuickOptimizationRanges() : getDetailedOptimizationRanges();

  const results = await runOptimization(markets, {
    ranges,
    startDate,
    endDate,
    onProgress: (p) => {
      printProgress(p.current, p.total);
    },
  });

  clearProgress();

  // Print results
  printOptimizationTable(results, parseInt(args.limit || "10", 10));

  // Save best config if requested
  if (args.export && results.length > 0) {
    const best = results[0];
    writeFileSync(args.export, JSON.stringify(best.config, null, 2));
    console.log(`Best config saved to ${args.export}`);
  }
}

// Command: genetic
async function commandGenetic(args: ReturnType<typeof parseArguments>["values"]) {
  const { startDate, endDate } = getDateRange(args);

  const markets = await loadOrFetchMarkets(startDate, endDate);
  if (!markets) return;

  console.log(`\nRunning genetic optimization on ${markets.length} markets...`);

  // Build GA config from args
  const gaConfig = {
    populationSize: parseInt(args.population || "50", 10),
    generations: parseInt(args.generations || "100", 10),
    mutationRate: parseFloat(args.mutation || "0.15"),
    trainingSplit: parseFloat(args["train-split"] || "0.7"),
    eliteCount: parseInt(args.elite || "5", 10),
  };

  console.log(`Population: ${gaConfig.populationSize}, Generations: ${gaConfig.generations}, Mutation: ${(gaConfig.mutationRate * 100).toFixed(0)}%`);
  console.log(`Training split: ${(gaConfig.trainingSplit * 100).toFixed(0)}%, Elite: ${gaConfig.eliteCount}\n`);

  const result = await runGeneticOptimization(markets, {
    gaConfig,
    baseConfig: {
      startingBalance: parseFloat(args.balance || "100"),
      startDate,
      endDate,
    },
    onProgress: (p) => printGeneticProgress(p),
  });

  clearGeneticProgress();

  // Print results
  printGeneticReport(result);

  // Export if requested
  if (args.export) {
    const ext = args.export.split(".").pop()?.toLowerCase();
    if (ext === "json") {
      writeFileSync(args.export, geneticResultToJSON(result));
      console.log(`Results exported to ${args.export}`);
    } else if (ext === "env") {
      writeFileSync(args.export, exportConfigForEnv(result));
      console.log(`Config exported to ${args.export}`);
    } else {
      // Default to JSON
      writeFileSync(args.export, geneticResultToJSON(result));
      console.log(`Results exported to ${args.export}`);
    }
  }
}

// Command: compare
async function commandCompare(args: ReturnType<typeof parseArguments>["values"]) {
  const { startDate, endDate } = getDateRange(args);

  const markets = await loadOrFetchMarkets(startDate, endDate);
  if (!markets) return;

  console.log(`\nComparing configurations on ${markets.length} markets...`);

  // Build configs for all modes
  const normalConfig: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    startDate,
    endDate,
    riskMode: "normal",
  };

  const superRiskConfig: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SUPER_RISK_CONFIG,
    startDate,
    endDate,
    riskMode: "super-risk",
  };

  const dynamicRiskConfig: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...DYNAMIC_RISK_CONFIG,
    startDate,
    endDate,
    riskMode: "dynamic-risk",
  };

  const safeConfig: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SAFE_CONFIG,
    startDate,
    endDate,
    riskMode: "safe",
  };

  // Run all backtests
  console.log("\nRunning backtests for all modes...");
  const results = [
    { label: "Normal Mode", result: runBacktest(normalConfig, markets) },
    { label: "Super-Risk Mode", result: runBacktest(superRiskConfig, markets) },
    { label: "Dynamic-Risk Mode", result: runBacktest(dynamicRiskConfig, markets) },
    { label: "Safe Mode", result: runBacktest(safeConfig, markets) },
  ];

  // Print comparison table
  console.log("\n=== MODE COMPARISON ===\n");
  console.log("Mode             | Trades | Win Rate | Total PnL | Max DD   | Sharpe");
  console.log("-----------------+--------+----------+-----------+----------+--------");

  for (const { label, result } of results) {
    const m = result.metrics;
    console.log(
      `${label.padEnd(16)} | ${m.totalTrades.toString().padStart(6)} | ${(m.winRate * 100).toFixed(1).padStart(7)}% | $${m.totalPnL.toFixed(2).padStart(8)} | ${(m.maxDrawdownPercent * 100).toFixed(1).padStart(7)}% | ${m.sharpeRatio.toFixed(2).padStart(6)}`
    );
  }

  console.log("");

  // Print individual results if verbose
  for (const { label, result } of results) {
    console.log(`\n--- ${label} ---`);
    printBacktestReport(result);
  }
}

// Command: history
async function commandHistory(args: ReturnType<typeof parseArguments>["values"]) {
  initBacktestDatabase();

  const runs = listBacktestRuns(parseInt(args.limit || "20", 10));

  if (runs.length === 0) {
    console.log("No backtest runs found.");
    return;
  }

  console.log("\n=== BACKTEST HISTORY ===\n");
  console.log("ID   | Date       | Markets | Status    | Config");
  console.log("-----+------------+---------+-----------+----------------------------------------");

  for (const run of runs) {
    const config = JSON.parse(run.config_json);
    const date = run.created_at.slice(0, 10);
    const configSummary = `entry=$${config.entryThreshold}, stop=$${config.stopLoss}, ${config.riskMode}`;

    console.log(
      `${run.id.toString().padStart(4)} | ${date} | ${run.markets_tested.toString().padStart(7)} | ${run.status.padEnd(9)} | ${configSummary}`
    );
  }

  console.log("");
}

// Command: stats
async function commandStats() {
  initBacktestDatabase();

  const stats = getCacheStats();

  console.log("\n=== CACHE STATISTICS ===\n");
  console.log(`Total Markets Cached: ${stats.totalMarkets}`);
  console.log(`Total Price Ticks: ${stats.totalPriceTicks}`);

  if (stats.dateRange.earliest && stats.dateRange.latest) {
    console.log(`Date Range: ${stats.dateRange.earliest.toISOString().slice(0, 10)} to ${stats.dateRange.latest.toISOString().slice(0, 10)}`);
  } else {
    console.log("Date Range: No data");
  }

  console.log("");
}

// Command: clear
async function commandClear(args: ReturnType<typeof parseArguments>["values"]) {
  initBacktestDatabase();

  if (args.force) {
    clearHistoricalData();
    clearBacktestData();
    console.log("All backtest and historical data cleared.");
  } else {
    clearBacktestData();
    console.log("Backtest runs cleared. Use --force to also clear historical market data.");
  }
}

// Main
async function main() {
  const { values: args, positionals } = parseArguments();
  const command = positionals[0];

  if (args.help || !command) {
    console.log(HELP);
    return;
  }

  try {
    switch (command) {
      case "run":
        await commandRun(args);
        break;
      case "fetch":
        await commandFetch(args);
        break;
      case "optimize":
        await commandOptimize(args);
        break;
      case "genetic":
        await commandGenetic(args);
        break;
      case "compare":
        await commandCompare(args);
        break;
      case "history":
        await commandHistory(args);
        break;
      case "stats":
        await commandStats();
        break;
      case "clear":
        await commandClear(args);
        break;
      default:
        console.log(`Unknown command: ${command}`);
        console.log(HELP);
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
