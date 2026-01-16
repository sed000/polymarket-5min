import type { BacktestConfig } from "../types";
import type { Chromosome, Genes, ParameterBounds } from "./types";
import { DEFAULT_BOUNDS } from "./types";

/**
 * Create a random chromosome with genes within the specified bounds
 */
export function createRandomChromosome(bounds: ParameterBounds = DEFAULT_BOUNDS): Chromosome {
  const genes: Genes = {
    entryThreshold: randomInRange(bounds.entryThreshold.min, bounds.entryThreshold.max),
    maxEntryPrice: randomInRange(bounds.maxEntryPrice.min, bounds.maxEntryPrice.max),
    stopLoss: randomInRange(bounds.stopLoss.min, bounds.stopLoss.max),
    stopLossDelayMs: Math.round(randomInRange(bounds.stopLossDelayMs.min, bounds.stopLossDelayMs.max)),
    maxSpread: randomInRange(bounds.maxSpread.min, bounds.maxSpread.max),
    timeWindowMs: Math.round(randomInRange(bounds.timeWindowMs.min, bounds.timeWindowMs.max)),
    profitTarget: randomInRange(bounds.profitTarget.min, bounds.profitTarget.max),
  };

  // Repair any constraint violations
  return repairChromosome({ genes, fitness: null, metrics: null, validationFitness: null, validationMetrics: null }, bounds);
}

/**
 * Repair a chromosome to satisfy constraints:
 * - entryThreshold <= maxEntryPrice - 0.01
 * - stopLoss < entryThreshold - 0.05
 * - profitTarget >= maxEntryPrice
 */
export function repairChromosome(chromosome: Chromosome, bounds: ParameterBounds = DEFAULT_BOUNDS): Chromosome {
  const genes = { ...chromosome.genes };

  // Round price values to 2 decimal places
  genes.entryThreshold = roundTo(genes.entryThreshold, 2);
  genes.maxEntryPrice = roundTo(genes.maxEntryPrice, 2);
  genes.stopLoss = roundTo(genes.stopLoss, 2);
  genes.maxSpread = roundTo(genes.maxSpread, 3);
  genes.profitTarget = roundTo(genes.profitTarget, 2);

  // Round time values to integers
  genes.stopLossDelayMs = Math.round(genes.stopLossDelayMs);
  genes.timeWindowMs = Math.round(genes.timeWindowMs);

  // Clamp all values within bounds
  genes.entryThreshold = clamp(genes.entryThreshold, bounds.entryThreshold.min, bounds.entryThreshold.max);
  genes.maxEntryPrice = clamp(genes.maxEntryPrice, bounds.maxEntryPrice.min, bounds.maxEntryPrice.max);
  genes.stopLoss = clamp(genes.stopLoss, bounds.stopLoss.min, bounds.stopLoss.max);
  genes.stopLossDelayMs = clamp(genes.stopLossDelayMs, bounds.stopLossDelayMs.min, bounds.stopLossDelayMs.max);
  genes.maxSpread = clamp(genes.maxSpread, bounds.maxSpread.min, bounds.maxSpread.max);
  genes.timeWindowMs = clamp(genes.timeWindowMs, bounds.timeWindowMs.min, bounds.timeWindowMs.max);
  genes.profitTarget = clamp(genes.profitTarget, bounds.profitTarget.min, bounds.profitTarget.max);

  // Constraint 1: entryThreshold must be <= maxEntryPrice - 0.01
  if (genes.entryThreshold > genes.maxEntryPrice - 0.01) {
    genes.maxEntryPrice = Math.min(genes.entryThreshold + 0.01, bounds.maxEntryPrice.max);
    // If still violated, adjust entryThreshold
    if (genes.entryThreshold > genes.maxEntryPrice - 0.01) {
      genes.entryThreshold = genes.maxEntryPrice - 0.01;
    }
  }

  // Constraint 2: stopLoss must be < entryThreshold - 0.05
  if (genes.stopLoss >= genes.entryThreshold - 0.05) {
    genes.stopLoss = Math.max(genes.entryThreshold - 0.06, bounds.stopLoss.min);
  }

  // Constraint 3: profitTarget must be >= maxEntryPrice
  if (genes.profitTarget < genes.maxEntryPrice) {
    genes.profitTarget = Math.min(genes.maxEntryPrice, bounds.profitTarget.max);
  }

  return {
    ...chromosome,
    genes,
  };
}

/**
 * Convert chromosome genes to a BacktestConfig
 */
export function chromosomeToConfig(
  chromosome: Chromosome,
  baseConfig: Partial<BacktestConfig>
): BacktestConfig {
  return {
    entryThreshold: chromosome.genes.entryThreshold,
    maxEntryPrice: chromosome.genes.maxEntryPrice,
    stopLoss: chromosome.genes.stopLoss,
    stopLossDelayMs: chromosome.genes.stopLossDelayMs,
    maxSpread: chromosome.genes.maxSpread,
    timeWindowMs: chromosome.genes.timeWindowMs,
    profitTarget: chromosome.genes.profitTarget,
    startingBalance: baseConfig.startingBalance ?? 100,
    slippage: baseConfig.slippage ?? 0.001,
    compoundLimit: baseConfig.compoundLimit ?? 0,
    baseBalance: baseConfig.baseBalance ?? 10,
    riskMode: baseConfig.riskMode ?? "normal",
    startDate: baseConfig.startDate ?? new Date(),
    endDate: baseConfig.endDate ?? new Date(),
  };
}

/**
 * Calculate genetic distance between two chromosomes
 * Used for diversity measurement
 */
export function calculateDistance(a: Chromosome, b: Chromosome, bounds: ParameterBounds = DEFAULT_BOUNDS): number {
  let sumSquared = 0;

  // Normalize each gene to [0, 1] range and calculate Euclidean distance
  const geneKeys = Object.keys(a.genes) as (keyof Genes)[];

  for (const key of geneKeys) {
    const range = bounds[key].max - bounds[key].min;
    if (range === 0) continue;

    const normA = (a.genes[key] - bounds[key].min) / range;
    const normB = (b.genes[key] - bounds[key].min) / range;
    sumSquared += Math.pow(normA - normB, 2);
  }

  return Math.sqrt(sumSquared / geneKeys.length);
}

/**
 * Clone a chromosome (deep copy)
 */
export function cloneChromosome(chromosome: Chromosome): Chromosome {
  return {
    genes: { ...chromosome.genes },
    fitness: null, // Reset fitness since it needs re-evaluation
    metrics: null,
    validationFitness: null,
    validationMetrics: null,
  };
}

/**
 * Create a chromosome from specific gene values
 */
export function createChromosome(genes: Partial<Genes>, bounds: ParameterBounds = DEFAULT_BOUNDS): Chromosome {
  const fullGenes: Genes = {
    entryThreshold: genes.entryThreshold ?? (bounds.entryThreshold.min + bounds.entryThreshold.max) / 2,
    maxEntryPrice: genes.maxEntryPrice ?? (bounds.maxEntryPrice.min + bounds.maxEntryPrice.max) / 2,
    stopLoss: genes.stopLoss ?? (bounds.stopLoss.min + bounds.stopLoss.max) / 2,
    stopLossDelayMs: genes.stopLossDelayMs ?? (bounds.stopLossDelayMs.min + bounds.stopLossDelayMs.max) / 2,
    maxSpread: genes.maxSpread ?? (bounds.maxSpread.min + bounds.maxSpread.max) / 2,
    timeWindowMs: genes.timeWindowMs ?? (bounds.timeWindowMs.min + bounds.timeWindowMs.max) / 2,
    profitTarget: genes.profitTarget ?? (bounds.profitTarget.min + bounds.profitTarget.max) / 2,
  };

  return repairChromosome(
    { genes: fullGenes, fitness: null, metrics: null, validationFitness: null, validationMetrics: null },
    bounds
  );
}

// Helper functions
function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
