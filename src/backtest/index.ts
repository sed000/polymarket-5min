#!/usr/bin/env bun
import { parseArgs } from "util";
import type { BacktestConfig } from "./types";
import { DEFAULT_BACKTEST_CONFIG } from "./types";
import { type RiskMode, type ModeConfig, type LadderModeConfig, type LadderStep, getConfigManager } from "../config";
import { fetchHistoricalDataset, loadCachedDataset, getCacheStats } from "./data-fetcher";
import { runBacktest } from "./engine";
import {
  runOptimization,
  getQuickOptimizationRanges,
  getDetailedOptimizationRanges,
  getLadderOptimizationRanges,
} from "./optimizer";
import { runGeneticOptimization } from "./genetic";
import { printGeneticProgress, clearGeneticProgress, printGeneticReport, geneticResultToJSON, exportConfigForEnv } from "./genetic/reporter";
import {
  printBacktestReport,
  printOptimizationTable,
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
  --mode <mode>       Risk mode: normal | ladder
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

// Load backtest config from trading.config.json
function isLadderModeConfig(mode: ModeConfig | LadderModeConfig): mode is LadderModeConfig {
  return "steps" in mode && Array.isArray((mode as LadderModeConfig).steps);
}

function getConfigFromFile(modeOverride?: string) {
  const configManager = getConfigManager();
  const backtestConfig = configManager.getBacktestConfig();
  const selectedMode = modeOverride ?? backtestConfig.mode;
  const mode = configManager.getMode(selectedMode);
  const profitTaking = configManager.getConfig().profitTaking;

  if (!mode) {
    throw new Error(`Backtest mode "${selectedMode}" not found in config file`);
  }

  if (isLadderModeConfig(mode)) {
    const firstEnabledStep = mode.steps.find(step => step.enabled);
    const ladderStopLoss = firstEnabledStep ? firstEnabledStep.stopLoss : 0.01;

    return {
      mode: selectedMode,
      entryThreshold: mode.entryThreshold,
      maxEntryPrice: mode.maxEntryPrice,
      stopLoss: ladderStopLoss,
      profitTarget: 0.99,
      maxSpread: mode.maxSpread,
      timeWindowMs: mode.timeWindowMs,
      startingBalance: backtestConfig.startingBalance,
      defaultDays: backtestConfig.days,
      slippage: backtestConfig.slippage,
      compoundLimit: profitTaking.compoundLimit,
      baseBalance: profitTaking.baseBalance,
      ladderSteps: mode.steps,
    };
  }

  return {
    mode: selectedMode,
    entryThreshold: mode.entryThreshold,
    maxEntryPrice: mode.maxEntryPrice,
    stopLoss: mode.stopLoss,
    profitTarget: mode.profitTarget,
    maxSpread: mode.maxSpread,
    timeWindowMs: mode.timeWindowMs,
    startingBalance: backtestConfig.startingBalance,
    defaultDays: backtestConfig.days,
    slippage: backtestConfig.slippage,
    compoundLimit: profitTaking.compoundLimit,
    baseBalance: profitTaking.baseBalance,
    ladderSteps: [],
  };
}

// Calculate date range
function getDateRange(args: ReturnType<typeof parseArguments>["values"]): { startDate: Date; endDate: Date } {
  const fileConfig = getConfigFromFile();
  const endDate = args.end ? new Date(args.end) : new Date();
  const days = parseInt(args.days || String(fileConfig.defaultDays), 10);
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
  if (config.maxSpread < 0 || config.maxSpread > 0.50) {
    errors.push(`maxSpread must be between 0 and 0.50 (got ${config.maxSpread})`);
  }
  if (config.slippage < 0 || config.slippage > 0.10) {
    errors.push(`slippage must be between 0 and 0.10 (got ${config.slippage})`);
  }
  if (config.startingBalance <= 0) {
    errors.push(`startingBalance must be positive (got ${config.startingBalance})`);
  }

  if (config.entryThreshold >= config.maxEntryPrice) {
    errors.push(`entryThreshold (${config.entryThreshold}) must be < maxEntryPrice (${config.maxEntryPrice})`);
  }

  if (config.riskMode === "ladder") {
    // Ladder-specific validations
    const ladderErrors = validateLadderSteps(config.ladderSteps);
    errors.push(...ladderErrors);
  } else {
    // Normal-mode validations
    if (config.stopLoss < 0.01 || config.stopLoss > 0.99) {
      errors.push(`stopLoss must be between 0.01 and 0.99 (got ${config.stopLoss})`);
    }
    if (config.profitTarget < 0.01 || config.profitTarget > 0.99) {
      errors.push(`profitTarget must be between 0.01 and 0.99 (got ${config.profitTarget})`);
    }
    if (config.entryThreshold >= config.maxEntryPrice) {
      errors.push(`entryThreshold (${config.entryThreshold}) must be < maxEntryPrice (${config.maxEntryPrice})`);
    }
    if (config.stopLoss >= config.entryThreshold) {
      errors.push(`stopLoss (${config.stopLoss}) must be < entryThreshold (${config.entryThreshold})`);
    }
    if (config.maxEntryPrice >= config.profitTarget) {
      errors.push(`maxEntryPrice (${config.maxEntryPrice}) must be < profitTarget (${config.profitTarget})`);
    }
  }

  // Time window validation
  if (config.timeWindowMs < 30000 || config.timeWindowMs > 900000) {
    errors.push(`timeWindowMs must be between 30000 (30s) and 900000 (15m) (got ${config.timeWindowMs})`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid backtest configuration:\n  - ${errors.join("\n  - ")}`);
  }
}

function validateLadderSteps(steps?: LadderStep[]): string[] {
  const errors: string[] = [];

  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push("ladderSteps must have at least one step");
    return errors;
  }

  const firstEnabledIndex = steps.findIndex(step => step.enabled);
  if (firstEnabledIndex === -1) {
    errors.push("ladderSteps must have at least one enabled step");
  }

  const stepIds = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepPrefix = `ladderSteps[${i}]`;

    if (!step.id || typeof step.id !== "string" || step.id.trim() === "") {
      errors.push(`${stepPrefix}.id must be a non-empty string`);
    } else if (stepIds.has(step.id)) {
      errors.push(`${stepPrefix}.id duplicate step ID "${step.id}"`);
    } else {
      stepIds.add(step.id);
    }

    if (step.stopLoss < 0.01 || step.stopLoss > 0.99) {
      errors.push(`${stepPrefix}.stopLoss must be between 0.01 and 0.99`);
    } else if (step.buy && step.stopLoss >= step.buy.triggerPrice) {
      errors.push(`${stepPrefix}.stopLoss must be less than buy.triggerPrice`);
    }

    if (!step.buy || typeof step.buy !== "object") {
      errors.push(`${stepPrefix}.buy is required`);
    } else {
      if (step.buy.triggerPrice < 0.01 || step.buy.triggerPrice > 0.99) {
        errors.push(`${stepPrefix}.buy.triggerPrice must be between 0.01 and 0.99`);
      }
      if (step.buy.sizeType !== "percent" && step.buy.sizeType !== "fixed") {
        errors.push(`${stepPrefix}.buy.sizeType must be "percent" or "fixed"`);
      }
      if (step.buy.sizeValue <= 0) {
        errors.push(`${stepPrefix}.buy.sizeValue must be positive`);
      }
      if (step.buy.sizeType === "percent" && step.buy.sizeValue > 100) {
        errors.push(`${stepPrefix}.buy.sizeValue must be <= 100`);
      }
    }

    if (!step.sell || typeof step.sell !== "object") {
      errors.push(`${stepPrefix}.sell is required`);
    } else {
      if (step.sell.triggerPrice < 0.01 || step.sell.triggerPrice > 0.99) {
        errors.push(`${stepPrefix}.sell.triggerPrice must be between 0.01 and 0.99`);
      }
      if (step.sell.sizeType !== "percent" && step.sell.sizeType !== "fixed") {
        errors.push(`${stepPrefix}.sell.sizeType must be "percent" or "fixed"`);
      }
      if (step.sell.sizeValue <= 0) {
        errors.push(`${stepPrefix}.sell.sizeValue must be positive`);
      }
      if (step.sell.sizeType === "percent" && step.sell.sizeValue > 100) {
        errors.push(`${stepPrefix}.sell.sizeValue must be <= 100`);
      }
    }

    if (typeof step.enabled !== "boolean") {
      errors.push(`${stepPrefix}.enabled must be a boolean`);
    }
  }

  return errors;
}

// Build config from arguments (config file is the base, CLI args override)
function buildConfig(args: ReturnType<typeof parseArguments>["values"], startDate: Date, endDate: Date): BacktestConfig {
  const defaultFileConfig = getConfigFromFile();
  const mode = (args.mode || defaultFileConfig.mode) as RiskMode;
  const fileConfig = getConfigFromFile(mode);
  const isLadder = mode === "ladder" || (fileConfig.ladderSteps?.length ?? 0) > 0;
  const riskMode: RiskMode = isLadder ? "ladder" : mode;

  if (isLadder && args.stop) {
    console.warn(`[WARN] --stop is ignored in ladder mode; configure per-step stop-loss in trading.config.json`);
  }

  const stopLoss = isLadder ? fileConfig.stopLoss : (args.stop ? parseFloat(args.stop) : fileConfig.stopLoss);

  // Build config: defaults < mode preset < config file < CLI args
  const config: BacktestConfig = {
    // Start with defaults
    ...DEFAULT_BACKTEST_CONFIG,
    // Apply config file/CLI values
    entryThreshold: args.entry ? parseFloat(args.entry) : fileConfig.entryThreshold,
    maxEntryPrice: args["max-entry"] ? parseFloat(args["max-entry"]) : fileConfig.maxEntryPrice,
    stopLoss,
    maxSpread: args.spread ? parseFloat(args.spread) : fileConfig.maxSpread,
    timeWindowMs: args.window ? parseInt(args.window, 10) : fileConfig.timeWindowMs,
    profitTarget: fileConfig.profitTarget,
    startingBalance: args.balance ? parseFloat(args.balance) : fileConfig.startingBalance,
    slippage: fileConfig.slippage,
    compoundLimit: fileConfig.compoundLimit,
    baseBalance: fileConfig.baseBalance,
    riskMode,
    ladderSteps: isLadder ? fileConfig.ladderSteps ?? [] : [],
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
  const baseConfig = buildConfig(args, startDate, endDate);

  const markets = await loadOrFetchMarkets(startDate, endDate);
  if (!markets) return;

  console.log(`\nOptimizing on ${markets.length} markets...`);

  const ranges =
    baseConfig.riskMode === "ladder"
      ? getLadderOptimizationRanges()
      : (args.quick ? getQuickOptimizationRanges() : getDetailedOptimizationRanges());

  const results = await runOptimization(markets, {
    ranges,
    baseConfig,
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
  const baseConfig = buildConfig(args, startDate, endDate);

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
    baseConfig,
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
