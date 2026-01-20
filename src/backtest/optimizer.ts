import type {
  BacktestConfig,
  BacktestResult,
  HistoricalMarket,
  OptimizationRanges,
  OptimizationResult,
  PerformanceMetrics,
} from "./types";
import { DEFAULT_BACKTEST_CONFIG, DEFAULT_OPTIMIZATION_RANGES } from "./types";
import { BacktestEngine } from "./engine";

export interface OptimizationProgress {
  current: number;
  total: number;
  currentConfig: Partial<BacktestConfig>;
  bestSoFar: OptimizationResult | null;
}

export type OptimizationProgressCallback = (progress: OptimizationProgress) => void;

/**
 * Generate all parameter combinations from ranges
 */
export function generateParameterCombinations(
  ranges: OptimizationRanges,
  baseConfig: Partial<BacktestConfig>
): Partial<BacktestConfig>[] {
  const combinations: Partial<BacktestConfig>[] = [];

  // Helper to generate values from a range
  const generateValues = (range: { min: number; max: number; step: number }): number[] => {
    const values: number[] = [];
    for (let v = range.min; v <= range.max; v += range.step) {
      values.push(Math.round(v * 1000) / 1000); // Round to avoid floating point issues
    }
    return values;
  };

  // Get all values for each parameter
  const entryThresholds = ranges.entryThreshold
    ? generateValues(ranges.entryThreshold)
    : [baseConfig.entryThreshold ?? DEFAULT_BACKTEST_CONFIG.entryThreshold];

  const maxEntryPrices = ranges.maxEntryPrice
    ? generateValues(ranges.maxEntryPrice)
    : [baseConfig.maxEntryPrice ?? DEFAULT_BACKTEST_CONFIG.maxEntryPrice];

  const stopLosses = ranges.stopLoss
    ? generateValues(ranges.stopLoss)
    : [baseConfig.stopLoss ?? DEFAULT_BACKTEST_CONFIG.stopLoss];

  const maxSpreads = ranges.maxSpread
    ? generateValues(ranges.maxSpread)
    : [baseConfig.maxSpread ?? DEFAULT_BACKTEST_CONFIG.maxSpread];

  const timeWindows = ranges.timeWindowMs
    ? generateValues(ranges.timeWindowMs)
    : [baseConfig.timeWindowMs ?? DEFAULT_BACKTEST_CONFIG.timeWindowMs];

  // Generate all combinations
  for (const entryThreshold of entryThresholds) {
    for (const maxEntryPrice of maxEntryPrices) {
      // Skip invalid combinations where entry threshold > max entry price
      if (entryThreshold > maxEntryPrice) continue;

      for (const stopLoss of stopLosses) {
        // Skip invalid combinations where stop loss > entry threshold
        if (stopLoss >= entryThreshold) continue;

        for (const maxSpread of maxSpreads) {
          for (const timeWindowMs of timeWindows) {
            combinations.push({
              ...baseConfig,
              entryThreshold,
              maxEntryPrice,
              stopLoss,
              maxSpread,
              timeWindowMs,
            });
          }
        }
      }
    }
  }

  return combinations;
}

/**
 * Run optimization with grid search
 */
export async function runOptimization(
  markets: HistoricalMarket[],
  options: {
    ranges?: OptimizationRanges;
    baseConfig?: Partial<BacktestConfig>;
    startDate: Date;
    endDate: Date;
    onProgress?: OptimizationProgressCallback;
  }
): Promise<OptimizationResult[]> {
  const ranges = options.ranges ?? DEFAULT_OPTIMIZATION_RANGES;
  const baseConfig: Partial<BacktestConfig> = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...options.baseConfig,
    startDate: options.startDate,
    endDate: options.endDate,
  };

  // Generate all parameter combinations
  const combinations = generateParameterCombinations(ranges, baseConfig);
  console.log(`Testing ${combinations.length} parameter combinations...`);

  const results: OptimizationResult[] = [];
  let bestResult: OptimizationResult | null = null;

  for (let i = 0; i < combinations.length; i++) {
    const params = combinations[i];

    // Build full config
    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      ...params,
      startDate: options.startDate,
      endDate: options.endDate,
    };

    // Run backtest
    const engine = new BacktestEngine(config);
    const result = engine.run(markets);

    const optimizationResult: OptimizationResult = {
      config,
      metrics: result.metrics,
      rank: 0, // Will be set after sorting
    };

    results.push(optimizationResult);

    // Track best result
    if (!bestResult || result.metrics.totalPnL > bestResult.metrics.totalPnL) {
      bestResult = optimizationResult;
    }

    // Report progress
    options.onProgress?.({
      current: i + 1,
      total: combinations.length,
      currentConfig: params,
      bestSoFar: bestResult,
    });
  }

  // Sort by total PnL (descending) and assign ranks
  results.sort((a, b) => b.metrics.totalPnL - a.metrics.totalPnL);
  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  return results;
}

/**
 * Get top N results by a specific metric
 */
export function getTopResults(
  results: OptimizationResult[],
  metric: keyof PerformanceMetrics,
  n: number = 10,
  ascending: boolean = false
): OptimizationResult[] {
  const sorted = [...results].sort((a, b) => {
    const aVal = a.metrics[metric] as number;
    const bVal = b.metrics[metric] as number;
    return ascending ? aVal - bVal : bVal - aVal;
  });

  return sorted.slice(0, n);
}

/**
 * Find optimal parameters for a specific metric
 */
export function findOptimalConfig(
  results: OptimizationResult[],
  metric: keyof PerformanceMetrics = "totalPnL"
): OptimizationResult | null {
  if (results.length === 0) return null;

  return results.reduce((best, current) => {
    const bestVal = best.metrics[metric] as number;
    const currentVal = current.metrics[metric] as number;
    return currentVal > bestVal ? current : best;
  });
}

/**
 * Quick optimization with limited parameter space
 * Good for fast initial testing
 */
export function getQuickOptimizationRanges(): OptimizationRanges {
  return {
    entryThreshold: { min: 0.80, max: 0.96, step: 0.04 },
    stopLoss: { min: 0.40, max: 0.70, step: 0.10 },
  };
}

/**
 * Detailed optimization with fine-grained parameter space
 * Takes longer but finds better optima
 */
export function getDetailedOptimizationRanges(): OptimizationRanges {
  return {
    entryThreshold: { min: 0.70, max: 0.96, step: 0.02 },
    maxEntryPrice: { min: 0.94, max: 0.99, step: 0.01 },
    stopLoss: { min: 0.30, max: 0.80, step: 0.05 },
    maxSpread: { min: 0.02, max: 0.06, step: 0.02 },
    timeWindowMs: { min: 120000, max: 600000, step: 120000 },
  };
}

/**
 * Compare two configs by running backtests
 */
export function compareConfigs(
  markets: HistoricalMarket[],
  config1: BacktestConfig,
  config2: BacktestConfig,
  labels: [string, string] = ["Config 1", "Config 2"]
): { label: string; result: BacktestResult }[] {
  const engine1 = new BacktestEngine(config1);
  const engine2 = new BacktestEngine(config2);

  return [
    { label: labels[0], result: engine1.run(markets) },
    { label: labels[1], result: engine2.run(markets) },
  ];
}
