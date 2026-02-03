import type { BacktestConfig, HistoricalMarket } from "../types";
import type {
  Chromosome,
  GeneticConfig,
  GeneticOptimizationResult,
  GeneticProgress,
  GenerationStats,
  ParameterBounds,
} from "./types";
import { DEFAULT_GA_CONFIG, DEFAULT_BOUNDS, DEFAULT_LADDER_BOUNDS } from "./types";
import { createRandomChromosome } from "./chromosome";
import {
  tournamentSelect,
  blendCrossover,
  combinedMutate,
  sortByFitness,
  getElite,
  calculateDiversity,
} from "./operators";
import { calculateFitness } from "./fitness";
import {
  splitDataset,
  evaluateOnTraining,
  validateCandidates,
  selectBestStrategy,
  detectOverfitting,
} from "./walk-forward";

export interface GeneticOptimizationOptions {
  gaConfig?: Partial<GeneticConfig>;
  bounds?: ParameterBounds;
  baseConfig?: Partial<BacktestConfig>;
  onProgress?: (progress: GeneticProgress) => void;
}

/**
 * Run genetic algorithm optimization to find the best trading strategy
 */
export async function runGeneticOptimization(
  markets: HistoricalMarket[],
  options: GeneticOptimizationOptions = {}
): Promise<GeneticOptimizationResult> {
  const startTime = Date.now();

  // Merge configs
  const config: GeneticConfig = { ...DEFAULT_GA_CONFIG, ...options.gaConfig };
  const baseConfig = options.baseConfig ?? {};
  const bounds =
    options.bounds ??
    (baseConfig.riskMode === "ladder" ? DEFAULT_LADDER_BOUNDS : DEFAULT_BOUNDS);

  // Split data for walk-forward validation
  const { training, validation, trainingDateRange, validationDateRange } = splitDataset(
    markets,
    config.trainingSplit
  );

  console.log(`Training set: ${training.length} markets (${trainingDateRange.start.toISOString().slice(0, 10)} - ${trainingDateRange.end.toISOString().slice(0, 10)})`);
  console.log(`Validation set: ${validation.length} markets (${validationDateRange.start.toISOString().slice(0, 10)} - ${validationDateRange.end.toISOString().slice(0, 10)})`);

  // Initialize population
  let population = initializePopulation(config.populationSize, bounds);
  let totalEvaluations = 0;

  // Report initialization
  options.onProgress?.({
    generation: 0,
    totalGenerations: config.generations,
    bestFitness: 0,
    avgFitness: 0,
    phase: "initialization",
    evaluations: 0,
  });

  // Evaluate initial population on training data
  for (const chromosome of population) {
    const { fitness, metrics } = evaluateOnTraining(chromosome, training, baseConfig);
    chromosome.fitness = fitness;
    chromosome.metrics = metrics;
    totalEvaluations++;
  }

  // Track generation history
  const generationHistory: GenerationStats[] = [];
  let bestFitnessSoFar = -Infinity;
  let convergenceCounter = 0;
  let convergedEarly = false;

  // Evolution loop
  for (let gen = 0; gen < config.generations; gen++) {
    // Sort population by fitness
    population = sortByFitness(population);

    // Collect generation stats
    const stats = collectGenerationStats(population, gen, totalEvaluations, bounds);
    generationHistory.push(stats);

    // Report progress
    options.onProgress?.({
      generation: gen,
      totalGenerations: config.generations,
      bestFitness: stats.bestFitness,
      avgFitness: stats.avgFitness,
      phase: "evolution",
      evaluations: totalEvaluations,
    });

    // Check convergence
    if (stats.bestFitness > bestFitnessSoFar + config.convergenceThreshold) {
      bestFitnessSoFar = stats.bestFitness;
      convergenceCounter = 0;
    } else {
      convergenceCounter++;
    }

    if (convergenceCounter >= config.convergenceGenerations) {
      convergedEarly = true;
      break;
    }

    // Create next generation
    const elite = getElite(population, config.eliteCount);
    const offspring: Chromosome[] = elite.map(e => ({ ...e, genes: { ...e.genes } }));

    while (offspring.length < config.populationSize) {
      // Selection
      const parent1 = tournamentSelect(population, config.tournamentSize);
      const parent2 = tournamentSelect(population, config.tournamentSize);

      // Crossover
      let children: [Chromosome, Chromosome];
      if (Math.random() < config.crossoverRate) {
        children = blendCrossover(parent1, parent2, 0.5, bounds);
      } else {
        children = [
          { ...parent1, genes: { ...parent1.genes }, fitness: null, metrics: null, validationFitness: null, validationMetrics: null },
          { ...parent2, genes: { ...parent2.genes }, fitness: null, metrics: null, validationFitness: null, validationMetrics: null },
        ];
      }

      // Mutation
      children[0] = combinedMutate(children[0], bounds, config.mutationRate);
      children[1] = combinedMutate(children[1], bounds, config.mutationRate);

      // Evaluate fitness
      for (const child of children) {
        const { fitness, metrics } = evaluateOnTraining(child, training, baseConfig);
        child.fitness = fitness;
        child.metrics = metrics;
        totalEvaluations++;
      }

      offspring.push(...children);
    }

    // Trim to population size
    population = offspring.slice(0, config.populationSize);
  }

  // Final sort
  population = sortByFitness(population);

  // Walk-forward validation on top candidates
  options.onProgress?.({
    generation: generationHistory.length,
    totalGenerations: config.generations,
    bestFitness: population[0].fitness ?? 0,
    avgFitness: 0,
    phase: "validation",
    evaluations: totalEvaluations,
  });

  const topCandidates = getElite(population, Math.min(10, config.populationSize));
  const validatedCandidates = validateCandidates(topCandidates, validation, baseConfig);

  // Select best based on validation performance
  const bestStrategy = selectBestStrategy(validatedCandidates);

  // Report completion
  options.onProgress?.({
    generation: generationHistory.length,
    totalGenerations: config.generations,
    bestFitness: bestStrategy.validationFitness ?? bestStrategy.fitness ?? 0,
    avgFitness: 0,
    phase: "complete",
    evaluations: totalEvaluations,
  });

  return {
    bestStrategy,
    topStrategies: validatedCandidates,
    inSampleMetrics: bestStrategy.metrics!,
    outOfSampleMetrics: bestStrategy.validationMetrics!,
    generationHistory,
    totalGenerations: generationHistory.length,
    totalEvaluations,
    convergedEarly,
    config,
    executionTimeMs: Date.now() - startTime,
    riskMode: baseConfig.riskMode ?? "normal",
  };
}

/**
 * Initialize population with random chromosomes
 */
function initializePopulation(size: number, bounds: ParameterBounds): Chromosome[] {
  const population: Chromosome[] = [];

  for (let i = 0; i < size; i++) {
    population.push(createRandomChromosome(bounds));
  }

  return population;
}

/**
 * Collect statistics for a generation
 */
function collectGenerationStats(
  population: Chromosome[],
  generation: number,
  evaluations: number,
  bounds: ParameterBounds
): GenerationStats {
  const validFitnesses = population
    .filter(c => c.fitness !== null)
    .map(c => c.fitness as number);

  const bestFitness = validFitnesses.length > 0 ? Math.max(...validFitnesses) : 0;
  const avgFitness = validFitnesses.length > 0
    ? validFitnesses.reduce((a, b) => a + b, 0) / validFitnesses.length
    : 0;
  const worstFitness = validFitnesses.length > 0 ? Math.min(...validFitnesses) : 0;

  const diversity = calculateDiversity(population, bounds);
  const bestChromosome = population.find(c => c.fitness === bestFitness) ?? population[0];

  return {
    generation,
    bestFitness,
    avgFitness,
    worstFitness,
    diversity,
    bestChromosome,
    evaluations,
  };
}

// Re-export types and utilities
export * from "./types";
export * from "./chromosome";
export * from "./operators";
export * from "./fitness";
export * from "./walk-forward";
