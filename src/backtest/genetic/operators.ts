import type { Chromosome, Genes, ParameterBounds } from "./types";
import { DEFAULT_BOUNDS } from "./types";
import { cloneChromosome, repairChromosome } from "./chromosome";

/**
 * Tournament selection - select the best chromosome from a random subset
 * Higher tournament size = more selective pressure
 */
export function tournamentSelect(
  population: Chromosome[],
  tournamentSize: number
): Chromosome {
  const validPopulation = population.filter(c => c.fitness !== null);
  if (validPopulation.length === 0) {
    throw new Error("No valid chromosomes in population for selection");
  }

  // Select random individuals for tournament
  const tournament: Chromosome[] = [];
  for (let i = 0; i < tournamentSize; i++) {
    const idx = Math.floor(Math.random() * validPopulation.length);
    tournament.push(validPopulation[idx]);
  }

  // Return the fittest
  return tournament.reduce((best, current) =>
    (current.fitness ?? -Infinity) > (best.fitness ?? -Infinity) ? current : best
  );
}

/**
 * BLX-alpha blend crossover for continuous parameters
 * Creates offspring by blending parent genes with exploration factor alpha
 */
export function blendCrossover(
  parent1: Chromosome,
  parent2: Chromosome,
  alpha: number = 0.5,
  bounds: ParameterBounds = DEFAULT_BOUNDS
): [Chromosome, Chromosome] {
  const child1Genes: Partial<Genes> = {};
  const child2Genes: Partial<Genes> = {};

  const geneKeys = Object.keys(parent1.genes) as (keyof Genes)[];

  for (const key of geneKeys) {
    const p1 = parent1.genes[key];
    const p2 = parent2.genes[key];

    const minVal = Math.min(p1, p2);
    const maxVal = Math.max(p1, p2);
    const range = maxVal - minVal;

    // BLX-alpha extends the range by alpha on each side
    const lowerBound = minVal - alpha * range;
    const upperBound = maxVal + alpha * range;

    // Generate two offspring values
    child1Genes[key] = lowerBound + Math.random() * (upperBound - lowerBound);
    child2Genes[key] = lowerBound + Math.random() * (upperBound - lowerBound);
  }

  const child1: Chromosome = {
    genes: child1Genes as Genes,
    fitness: null,
    metrics: null,
    validationFitness: null,
    validationMetrics: null,
  };

  const child2: Chromosome = {
    genes: child2Genes as Genes,
    fitness: null,
    metrics: null,
    validationFitness: null,
    validationMetrics: null,
  };

  // Repair to ensure constraints and bounds
  return [repairChromosome(child1, bounds), repairChromosome(child2, bounds)];
}

/**
 * Uniform crossover - each gene randomly selected from either parent
 */
export function uniformCrossover(
  parent1: Chromosome,
  parent2: Chromosome,
  bounds: ParameterBounds = DEFAULT_BOUNDS
): [Chromosome, Chromosome] {
  const child1Genes: Partial<Genes> = {};
  const child2Genes: Partial<Genes> = {};

  const geneKeys = Object.keys(parent1.genes) as (keyof Genes)[];

  for (const key of geneKeys) {
    if (Math.random() < 0.5) {
      child1Genes[key] = parent1.genes[key];
      child2Genes[key] = parent2.genes[key];
    } else {
      child1Genes[key] = parent2.genes[key];
      child2Genes[key] = parent1.genes[key];
    }
  }

  const child1: Chromosome = {
    genes: child1Genes as Genes,
    fitness: null,
    metrics: null,
    validationFitness: null,
    validationMetrics: null,
  };

  const child2: Chromosome = {
    genes: child2Genes as Genes,
    fitness: null,
    metrics: null,
    validationFitness: null,
    validationMetrics: null,
  };

  return [repairChromosome(child1, bounds), repairChromosome(child2, bounds)];
}

/**
 * Gaussian mutation - add Gaussian noise to each gene with probability mutationRate
 * sigma is the standard deviation as a fraction of the parameter range
 */
export function gaussianMutate(
  chromosome: Chromosome,
  bounds: ParameterBounds = DEFAULT_BOUNDS,
  mutationRate: number = 0.15,
  sigma: number = 0.1
): Chromosome {
  const mutated = cloneChromosome(chromosome);
  const geneKeys = Object.keys(mutated.genes) as (keyof Genes)[];

  for (const key of geneKeys) {
    if (Math.random() < mutationRate) {
      const range = bounds[key].max - bounds[key].min;
      const noise = gaussianRandom() * sigma * range;
      mutated.genes[key] = mutated.genes[key] + noise;
    }
  }

  return repairChromosome(mutated, bounds);
}

/**
 * Reset mutation - occasionally reset a gene to random value
 * Used to maintain diversity
 */
export function resetMutate(
  chromosome: Chromosome,
  bounds: ParameterBounds = DEFAULT_BOUNDS,
  resetProbability: number = 0.05
): Chromosome {
  const mutated = cloneChromosome(chromosome);
  const geneKeys = Object.keys(mutated.genes) as (keyof Genes)[];

  for (const key of geneKeys) {
    if (Math.random() < resetProbability) {
      mutated.genes[key] = bounds[key].min + Math.random() * (bounds[key].max - bounds[key].min);
    }
  }

  return repairChromosome(mutated, bounds);
}

/**
 * Creep mutation - small incremental changes
 * Good for fine-tuning near good solutions
 */
export function creepMutate(
  chromosome: Chromosome,
  bounds: ParameterBounds = DEFAULT_BOUNDS,
  mutationRate: number = 0.2,
  creepFactor: number = 0.05
): Chromosome {
  const mutated = cloneChromosome(chromosome);
  const geneKeys = Object.keys(mutated.genes) as (keyof Genes)[];

  for (const key of geneKeys) {
    if (Math.random() < mutationRate) {
      const range = bounds[key].max - bounds[key].min;
      const creep = (Math.random() - 0.5) * 2 * creepFactor * range;
      mutated.genes[key] = mutated.genes[key] + creep;
    }
  }

  return repairChromosome(mutated, bounds);
}

/**
 * Combined mutation - applies both Gaussian and occasional reset
 */
export function combinedMutate(
  chromosome: Chromosome,
  bounds: ParameterBounds = DEFAULT_BOUNDS,
  mutationRate: number = 0.15,
  resetRate: number = 0.02
): Chromosome {
  let mutated = gaussianMutate(chromosome, bounds, mutationRate);
  mutated = resetMutate(mutated, bounds, resetRate);
  return mutated;
}

/**
 * Initialize a population of random chromosomes
 */
export function initializePopulation(
  size: number,
  bounds: ParameterBounds = DEFAULT_BOUNDS
): Chromosome[] {
  const population: Chromosome[] = [];

  // Import createRandomChromosome here to avoid circular dependency
  const { createRandomChromosome } = require("./chromosome");

  for (let i = 0; i < size; i++) {
    population.push(createRandomChromosome(bounds));
  }

  return population;
}

/**
 * Sort population by fitness (descending - best first)
 */
export function sortByFitness(population: Chromosome[]): Chromosome[] {
  return [...population].sort((a, b) => {
    const fitnessA = a.fitness ?? -Infinity;
    const fitnessB = b.fitness ?? -Infinity;
    return fitnessB - fitnessA;
  });
}

/**
 * Get the elite (top N) chromosomes
 */
export function getElite(population: Chromosome[], n: number): Chromosome[] {
  const sorted = sortByFitness(population);
  return sorted.slice(0, n).map(c => ({
    ...c,
    genes: { ...c.genes },
  }));
}

/**
 * Calculate population diversity (average pairwise distance)
 */
export function calculateDiversity(population: Chromosome[], bounds: ParameterBounds = DEFAULT_BOUNDS): number {
  const { calculateDistance } = require("./chromosome");

  if (population.length < 2) return 0;

  let totalDistance = 0;
  let pairs = 0;

  // Sample-based diversity for large populations
  const maxPairs = Math.min(100, (population.length * (population.length - 1)) / 2);
  const sampleSize = Math.min(population.length, 15);

  for (let i = 0; i < sampleSize; i++) {
    for (let j = i + 1; j < sampleSize; j++) {
      totalDistance += calculateDistance(population[i], population[j], bounds);
      pairs++;
      if (pairs >= maxPairs) break;
    }
    if (pairs >= maxPairs) break;
  }

  return pairs > 0 ? totalDistance / pairs : 0;
}

// Helper: Box-Muller transform for Gaussian random numbers
function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
