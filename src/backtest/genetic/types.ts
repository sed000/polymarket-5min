import type { BacktestConfig, PerformanceMetrics } from "../types";

// Parameter bounds for optimization
export interface ParameterBounds {
  entryThreshold: { min: number; max: number };
  maxEntryPrice: { min: number; max: number };
  stopLoss: { min: number; max: number };
  maxSpread: { min: number; max: number };
  timeWindowMs: { min: number; max: number };
  profitTarget: { min: number; max: number };
}

// Gene values for a trading strategy
export interface Genes {
  entryThreshold: number;
  maxEntryPrice: number;
  stopLoss: number;
  maxSpread: number;
  timeWindowMs: number;
  profitTarget: number;
}

// Individual chromosome representing a trading strategy
export interface Chromosome {
  genes: Genes;
  fitness: number | null;
  metrics: PerformanceMetrics | null;
  validationFitness: number | null;
  validationMetrics: PerformanceMetrics | null;
}

// GA configuration
export interface GeneticConfig {
  populationSize: number;
  generations: number;
  eliteCount: number;
  mutationRate: number;
  crossoverRate: number;
  tournamentSize: number;
  convergenceThreshold: number;
  convergenceGenerations: number;
  trainingSplit: number;
}

// Generation statistics
export interface GenerationStats {
  generation: number;
  bestFitness: number;
  avgFitness: number;
  worstFitness: number;
  diversity: number;
  bestChromosome: Chromosome;
  evaluations: number;
}

// Final optimization result
export interface GeneticOptimizationResult {
  bestStrategy: Chromosome;
  topStrategies: Chromosome[];
  inSampleMetrics: PerformanceMetrics;
  outOfSampleMetrics: PerformanceMetrics;
  generationHistory: GenerationStats[];
  totalGenerations: number;
  totalEvaluations: number;
  convergedEarly: boolean;
  config: GeneticConfig;
  executionTimeMs: number;
}

// Progress callback for UI updates
export interface GeneticProgress {
  generation: number;
  totalGenerations: number;
  bestFitness: number;
  avgFitness: number;
  phase: "initialization" | "evolution" | "validation" | "complete";
  evaluations: number;
}

// Default GA configuration
export const DEFAULT_GA_CONFIG: GeneticConfig = {
  populationSize: 50,
  generations: 100,
  eliteCount: 5,
  mutationRate: 0.15,
  crossoverRate: 0.8,
  tournamentSize: 5,
  convergenceThreshold: 0.001,
  convergenceGenerations: 10,
  trainingSplit: 0.7,
};

// Default parameter bounds
export const DEFAULT_BOUNDS: ParameterBounds = {
  entryThreshold: { min: 0.70, max: 0.96 },
  maxEntryPrice: { min: 0.92, max: 0.99 },
  stopLoss: { min: 0.30, max: 0.80 },
  maxSpread: { min: 0.02, max: 0.08 },
  timeWindowMs: { min: 60000, max: 900000 },
  profitTarget: { min: 0.98, max: 0.99 },
};
