import type { PerformanceMetrics } from "../types";

/**
 * Calculate fitness score for a trading strategy based on its performance metrics
 *
 * Objective: Maximize risk-adjusted returns
 * Primary: Sharpe Ratio (scaled)
 * Secondary: Win rate, profit factor, drawdown, ROC
 * Constraints: Positive PnL, acceptable drawdown, minimum trades
 */
export function calculateFitness(metrics: PerformanceMetrics): number {
  // Hard constraints - return heavily penalized fitness
  if (metrics.totalPnL <= 0) {
    return -1000 + metrics.totalPnL; // Slightly differentiate negative strategies
  }

  if (metrics.maxDrawdownPercent > 0.30) {
    return -500 - (metrics.maxDrawdownPercent - 0.30) * 100; // Penalize excess drawdown
  }

  if (metrics.totalTrades < 5) {
    return -100 + metrics.totalTrades * 10; // Too few trades to be statistically meaningful
  }

  // Primary objective: Sharpe Ratio (scaled up for precision)
  // Sharpe of 1.0 = 100 points, 2.0 = 200 points
  let fitness = metrics.sharpeRatio * 100;

  // Win rate bonus (0-10 points)
  // Higher win rate = more consistent strategy
  fitness += metrics.winRate * 10;

  // Profit factor bonus (0-20 points, capped at PF of 3)
  // PF > 1 means gross profit exceeds gross loss
  const pfBonus = Math.min(metrics.profitFactor === Infinity ? 3 : metrics.profitFactor, 3) * 6.67;
  fitness += pfBonus;

  // Drawdown penalty (reduces fitness as drawdown approaches 30%)
  // Max penalty of 15 points at 30% drawdown
  const ddPenalty = (metrics.maxDrawdownPercent / 0.30) * 15;
  fitness -= ddPenalty;

  // Return on capital bonus (scaled logarithmically to prevent extreme positions)
  // log1p(0.5) * 10 = ~4 points, log1p(1.0) * 10 = ~7 points
  const rocBonus = Math.log1p(Math.max(0, metrics.returnOnCapital)) * 10;
  fitness += rocBonus;

  // Consistency bonus (lower max consecutive losses is better)
  // Rewards strategies that don't have long losing streaks
  if (metrics.maxConsecutiveLosses <= 3) {
    fitness += 10;
  } else if (metrics.maxConsecutiveLosses <= 5) {
    fitness += 5;
  } else if (metrics.maxConsecutiveLosses <= 7) {
    fitness += 2;
  }

  // Trade frequency bonus - slightly favor more active strategies
  // (but not too much to avoid overtrading)
  const tradeBonus = Math.min(metrics.totalTrades / 20, 1) * 5;
  fitness += tradeBonus;

  // Expectancy bonus - reward high expectancy per trade
  if (metrics.expectancy > 0) {
    fitness += Math.min(metrics.expectancy * 10, 15);
  }

  return fitness;
}

/**
 * Alternative fitness function focused purely on profit
 */
export function calculateProfitFitness(metrics: PerformanceMetrics): number {
  if (metrics.totalTrades < 3) {
    return -100;
  }

  // Simple profit-based fitness
  let fitness = metrics.totalPnL;

  // Penalize drawdown
  fitness -= metrics.maxDrawdown * 0.5;

  return fitness;
}

/**
 * Custom fitness with configurable weights
 */
export interface FitnessWeights {
  sharpe: number;
  winRate: number;
  profitFactor: number;
  drawdown: number;
  roc: number;
  consistency: number;
}

export const DEFAULT_FITNESS_WEIGHTS: FitnessWeights = {
  sharpe: 100,
  winRate: 10,
  profitFactor: 20,
  drawdown: 15,
  roc: 10,
  consistency: 10,
};

export function calculateWeightedFitness(
  metrics: PerformanceMetrics,
  weights: FitnessWeights = DEFAULT_FITNESS_WEIGHTS
): number {
  // Constraints
  if (metrics.totalPnL <= 0) return -1000;
  if (metrics.maxDrawdownPercent > 0.30) return -500;
  if (metrics.totalTrades < 5) return -100;

  let fitness = 0;

  fitness += metrics.sharpeRatio * weights.sharpe;
  fitness += metrics.winRate * weights.winRate;
  fitness += Math.min(metrics.profitFactor === Infinity ? 3 : metrics.profitFactor, 3) * (weights.profitFactor / 3);
  fitness -= (metrics.maxDrawdownPercent / 0.30) * weights.drawdown;
  fitness += Math.log1p(Math.max(0, metrics.returnOnCapital)) * weights.roc;

  if (metrics.maxConsecutiveLosses <= 3) {
    fitness += weights.consistency;
  } else if (metrics.maxConsecutiveLosses <= 5) {
    fitness += weights.consistency * 0.5;
  }

  return fitness;
}

/**
 * Calculate a normalized score (0-100) for display purposes
 */
export function normalizeScore(fitness: number): number {
  // Map typical fitness range to 0-100
  // Assuming good strategies have fitness 50-300
  const normalized = ((fitness + 100) / 400) * 100;
  return Math.max(0, Math.min(100, normalized));
}

/**
 * Compare two fitness values
 */
export function isBetter(fitness1: number | null, fitness2: number | null): boolean {
  if (fitness1 === null) return false;
  if (fitness2 === null) return true;
  return fitness1 > fitness2;
}

/**
 * Check if a strategy passes minimum quality thresholds
 */
export function passesQualityThreshold(metrics: PerformanceMetrics): boolean {
  return (
    metrics.totalPnL > 0 &&
    metrics.maxDrawdownPercent <= 0.30 &&
    metrics.totalTrades >= 5 &&
    metrics.winRate >= 0.40 &&
    metrics.sharpeRatio > 0
  );
}
