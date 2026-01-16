import type { BacktestConfig, HistoricalMarket, PerformanceMetrics } from "../types";
import { runBacktest } from "../engine";
import type { Chromosome } from "./types";
import { chromosomeToConfig } from "./chromosome";
import { calculateFitness } from "./fitness";

export interface DatasetSplit {
  training: HistoricalMarket[];
  validation: HistoricalMarket[];
  trainingDateRange: { start: Date; end: Date };
  validationDateRange: { start: Date; end: Date };
}

/**
 * Split markets into training and validation sets chronologically
 * Training set comes first (earlier dates), validation set comes last (later dates)
 */
export function splitDataset(
  markets: HistoricalMarket[],
  trainRatio: number = 0.7
): DatasetSplit {
  // Sort by start date
  const sorted = [...markets].sort(
    (a, b) => a.startDate.getTime() - b.startDate.getTime()
  );

  const splitIndex = Math.floor(sorted.length * trainRatio);

  const training = sorted.slice(0, splitIndex);
  const validation = sorted.slice(splitIndex);

  return {
    training,
    validation,
    trainingDateRange: {
      start: training.length > 0 ? training[0].startDate : new Date(),
      end: training.length > 0 ? training[training.length - 1].endDate : new Date(),
    },
    validationDateRange: {
      start: validation.length > 0 ? validation[0].startDate : new Date(),
      end: validation.length > 0 ? validation[validation.length - 1].endDate : new Date(),
    },
  };
}

/**
 * Evaluate a chromosome on training data
 * Returns fitness score and performance metrics
 */
export function evaluateOnTraining(
  chromosome: Chromosome,
  trainingMarkets: HistoricalMarket[],
  baseConfig: Partial<BacktestConfig>
): { fitness: number; metrics: PerformanceMetrics } {
  const config = chromosomeToConfig(chromosome, baseConfig);
  const result = runBacktest(config, trainingMarkets);
  const fitness = calculateFitness(result.metrics);

  return { fitness, metrics: result.metrics };
}

/**
 * Evaluate a chromosome on validation data
 * Used for out-of-sample testing
 */
export function evaluateOnValidation(
  chromosome: Chromosome,
  validationMarkets: HistoricalMarket[],
  baseConfig: Partial<BacktestConfig>
): { fitness: number; metrics: PerformanceMetrics } {
  const config = chromosomeToConfig(chromosome, baseConfig);
  const result = runBacktest(config, validationMarkets);
  const fitness = calculateFitness(result.metrics);

  return { fitness, metrics: result.metrics };
}

/**
 * Validate top candidates on out-of-sample data
 * Updates chromosome with validation fitness and metrics
 */
export function validateCandidates(
  candidates: Chromosome[],
  validationMarkets: HistoricalMarket[],
  baseConfig: Partial<BacktestConfig>
): Chromosome[] {
  return candidates.map(candidate => {
    const { fitness, metrics } = evaluateOnValidation(
      candidate,
      validationMarkets,
      baseConfig
    );

    return {
      ...candidate,
      validationFitness: fitness,
      validationMetrics: metrics,
    };
  });
}

/**
 * Overfitting analysis result
 */
export interface OverfitAnalysis {
  isOverfit: boolean;
  divergenceScore: number;
  pnlDrop: number;
  pnlDropPercent: number;
  winRateDrop: number;
  sharpeDrop: number;
  recommendation: string;
}

/**
 * Detect potential overfitting by comparing in-sample vs out-of-sample performance
 */
export function detectOverfitting(
  inSampleMetrics: PerformanceMetrics,
  outOfSampleMetrics: PerformanceMetrics
): OverfitAnalysis {
  // Calculate performance drops
  const pnlDrop = inSampleMetrics.totalPnL - outOfSampleMetrics.totalPnL;
  const pnlDropPercent = inSampleMetrics.totalPnL > 0
    ? pnlDrop / inSampleMetrics.totalPnL
    : 0;

  const winRateDrop = inSampleMetrics.winRate - outOfSampleMetrics.winRate;
  const sharpeDrop = inSampleMetrics.sharpeRatio - outOfSampleMetrics.sharpeRatio;

  // Calculate divergence score (weighted combination of drops)
  // Higher score = more likely overfit
  let divergenceScore = 0;

  // PnL divergence (major indicator)
  divergenceScore += Math.max(0, pnlDropPercent) * 40;

  // Win rate divergence
  divergenceScore += Math.max(0, winRateDrop) * 30;

  // Sharpe divergence
  if (inSampleMetrics.sharpeRatio > 0) {
    const sharpeDropPercent = sharpeDrop / inSampleMetrics.sharpeRatio;
    divergenceScore += Math.max(0, sharpeDropPercent) * 30;
  }

  // Determine if overfit
  const isOverfit = divergenceScore > 30 || pnlDropPercent > 0.50;

  // Generate recommendation
  let recommendation: string;
  if (divergenceScore < 15) {
    recommendation = "Strategy generalizes well. Safe to use with live trading.";
  } else if (divergenceScore < 30) {
    recommendation = "Moderate divergence. Consider reducing position sizes or tightening parameters.";
  } else if (divergenceScore < 50) {
    recommendation = "Significant overfitting detected. Re-optimize with different parameters or more data.";
  } else {
    recommendation = "Severe overfitting. Strategy is not robust. Do not use for live trading.";
  }

  return {
    isOverfit,
    divergenceScore,
    pnlDrop,
    pnlDropPercent,
    winRateDrop,
    sharpeDrop,
    recommendation,
  };
}

/**
 * Select best strategy based on both training and validation performance
 * Prioritizes validation performance to avoid overfitting
 */
export function selectBestStrategy(candidates: Chromosome[]): Chromosome {
  // Filter to only those with validation results
  const validated = candidates.filter(
    c => c.validationFitness !== null && c.validationMetrics !== null
  );

  if (validated.length === 0) {
    // Fall back to training fitness
    return candidates.reduce((best, current) =>
      (current.fitness ?? -Infinity) > (best.fitness ?? -Infinity) ? current : best
    );
  }

  // Sort by validation fitness (prioritize out-of-sample performance)
  const sorted = [...validated].sort((a, b) =>
    (b.validationFitness ?? -Infinity) - (a.validationFitness ?? -Infinity)
  );

  // Return best by validation
  return sorted[0];
}

/**
 * Calculate robustness score (0-100) based on training vs validation consistency
 */
export function calculateRobustnessScore(
  inSampleMetrics: PerformanceMetrics,
  outOfSampleMetrics: PerformanceMetrics
): number {
  const analysis = detectOverfitting(inSampleMetrics, outOfSampleMetrics);

  // Invert divergence score and scale to 0-100
  const robustness = Math.max(0, 100 - analysis.divergenceScore * 2);

  // Bonus for positive OOS performance
  let bonus = 0;
  if (outOfSampleMetrics.totalPnL > 0) bonus += 10;
  if (outOfSampleMetrics.sharpeRatio > 0) bonus += 10;
  if (outOfSampleMetrics.winRate > 0.5) bonus += 5;

  return Math.min(100, robustness + bonus);
}
