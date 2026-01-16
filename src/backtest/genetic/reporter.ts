import type { PerformanceMetrics } from "../types";
import type { GeneticOptimizationResult, GeneticProgress, GenerationStats, Chromosome } from "./types";
import { detectOverfitting, calculateRobustnessScore } from "./walk-forward";

/**
 * Print progress during genetic optimization
 */
export function printGeneticProgress(progress: GeneticProgress): void {
  const percent = ((progress.generation / progress.totalGenerations) * 100).toFixed(0);
  const bar = createProgressBar(progress.generation, progress.totalGenerations, 30);

  const phaseLabel = {
    initialization: "Init",
    evolution: "Evolving",
    validation: "Validating",
    complete: "Done",
  }[progress.phase];

  process.stdout.write(
    `\r[${bar}] ${percent.padStart(3)}% | Gen ${progress.generation.toString().padStart(3)}/${progress.totalGenerations} | ` +
    `Best: ${progress.bestFitness.toFixed(1).padStart(7)} | Avg: ${progress.avgFitness.toFixed(1).padStart(7)} | ` +
    `${phaseLabel.padEnd(10)} | Evals: ${progress.evaluations}`
  );
}

/**
 * Clear progress line
 */
export function clearGeneticProgress(): void {
  process.stdout.write("\r" + " ".repeat(120) + "\r");
}

/**
 * Print full genetic optimization report
 */
export function printGeneticReport(result: GeneticOptimizationResult): void {
  console.log("\n");
  console.log("=".repeat(80));
  console.log("              GENETIC ALGORITHM OPTIMIZATION RESULTS");
  console.log("=".repeat(80));

  // Optimization Summary
  console.log("\n--- Optimization Summary ---");
  console.log(`  Generations Run:     ${result.totalGenerations}`);
  console.log(`  Total Evaluations:   ${result.totalEvaluations}`);
  console.log(`  Converged Early:     ${result.convergedEarly ? "Yes" : "No"}`);
  console.log(`  Execution Time:      ${(result.executionTimeMs / 1000).toFixed(1)}s`);
  console.log(`  Population Size:     ${result.config.populationSize}`);
  console.log(`  Mutation Rate:       ${(result.config.mutationRate * 100).toFixed(0)}%`);
  console.log(`  Training Split:      ${(result.config.trainingSplit * 100).toFixed(0)}%`);

  // Best Strategy Parameters
  console.log("\n--- Best Strategy Parameters ---");
  const genes = result.bestStrategy.genes;
  console.log(`  Entry Threshold:     $${genes.entryThreshold.toFixed(2)}`);
  console.log(`  Max Entry Price:     $${genes.maxEntryPrice.toFixed(2)}`);
  console.log(`  Stop Loss:           $${genes.stopLoss.toFixed(2)}`);
  console.log(`  Stop Loss Delay:     ${genes.stopLossDelayMs}ms`);
  console.log(`  Max Spread:          $${genes.maxSpread.toFixed(3)}`);
  console.log(`  Time Window:         ${(genes.timeWindowMs / 60000).toFixed(1)} min`);
  console.log(`  Profit Target:       $${genes.profitTarget.toFixed(2)}`);

  // In-Sample Performance
  console.log("\n--- In-Sample Performance (Training) ---");
  printMetricsSummary(result.inSampleMetrics);

  // Out-of-Sample Performance
  console.log("\n--- Out-of-Sample Performance (Validation) ---");
  printMetricsSummary(result.outOfSampleMetrics);

  // Overfitting Analysis
  const overfitAnalysis = detectOverfitting(result.inSampleMetrics, result.outOfSampleMetrics);
  const robustness = calculateRobustnessScore(result.inSampleMetrics, result.outOfSampleMetrics);

  console.log("\n--- Robustness Analysis ---");
  console.log(`  Robustness Score:    ${robustness.toFixed(0)}/100`);
  console.log(`  Divergence Score:    ${overfitAnalysis.divergenceScore.toFixed(1)}`);
  console.log(`  PnL Drop:            $${overfitAnalysis.pnlDrop.toFixed(2)} (${(overfitAnalysis.pnlDropPercent * 100).toFixed(1)}%)`);
  console.log(`  Win Rate Drop:       ${(overfitAnalysis.winRateDrop * 100).toFixed(1)}%`);
  console.log(`  Sharpe Drop:         ${overfitAnalysis.sharpeDrop.toFixed(2)}`);
  console.log(`  Status:              ${overfitAnalysis.isOverfit ? "WARNING - Possible Overfit" : "Good - Generalizes Well"}`);
  console.log(`  Recommendation:      ${overfitAnalysis.recommendation}`);

  // Convergence Plot
  if (result.generationHistory.length > 1) {
    console.log("\n--- Fitness Convergence ---");
    printConvergencePlot(result.generationHistory);
  }

  // Top 5 Strategies
  console.log("\n--- Top 5 Strategies (by validation performance) ---");
  printTopStrategies(result.topStrategies.slice(0, 5));

  console.log("\n" + "=".repeat(80));
}

/**
 * Print metrics summary
 */
function printMetricsSummary(m: PerformanceMetrics): void {
  console.log(`  Trades:              ${m.totalTrades} (${m.wins}W / ${m.losses}L)`);
  console.log(`  Win Rate:            ${(m.winRate * 100).toFixed(1)}%`);
  console.log(`  Total PnL:           $${m.totalPnL.toFixed(2)}`);
  console.log(`  Return on Capital:   ${(m.returnOnCapital * 100).toFixed(1)}%`);
  console.log(`  Max Drawdown:        ${(m.maxDrawdownPercent * 100).toFixed(1)}%`);
  console.log(`  Sharpe Ratio:        ${m.sharpeRatio.toFixed(2)}`);
  console.log(`  Profit Factor:       ${m.profitFactor === Infinity ? "Inf" : m.profitFactor.toFixed(2)}`);
  console.log(`  Expectancy:          $${m.expectancy.toFixed(2)}`);
  console.log(`  Max Consecutive L:   ${m.maxConsecutiveLosses}`);
}

/**
 * Print top strategies table
 */
function printTopStrategies(strategies: Chromosome[]): void {
  console.log("  Rank | Entry  | MaxEntry | Stop   | Delay   | ValPnL   | ValWin% | TrainPnL");
  console.log("  -----+--------+----------+--------+---------+----------+---------+---------");

  strategies.forEach((s, i) => {
    const valPnL = s.validationMetrics?.totalPnL ?? 0;
    const valWin = s.validationMetrics?.winRate ?? 0;
    const trainPnL = s.metrics?.totalPnL ?? 0;

    console.log(
      `  ${(i + 1).toString().padStart(4)} | ` +
      `$${s.genes.entryThreshold.toFixed(2)} | ` +
      `$${s.genes.maxEntryPrice.toFixed(2)}   | ` +
      `$${s.genes.stopLoss.toFixed(2)} | ` +
      `${s.genes.stopLossDelayMs.toString().padStart(5)}ms | ` +
      `$${valPnL.toFixed(2).padStart(7)} | ` +
      `${(valWin * 100).toFixed(0).padStart(5)}% | ` +
      `$${trainPnL.toFixed(2).padStart(7)}`
    );
  });
}

/**
 * Print ASCII convergence plot
 */
function printConvergencePlot(history: GenerationStats[]): void {
  const maxFitness = Math.max(...history.map(h => h.bestFitness));
  const minFitness = Math.min(...history.map(h => h.bestFitness));
  const range = maxFitness - minFitness || 1;

  const height = 10;
  const width = Math.min(60, history.length);

  // Sample points if too many generations
  const step = Math.ceil(history.length / width);
  const samples = history.filter((_, i) => i % step === 0);

  // Build plot
  const plot: string[][] = [];
  for (let row = 0; row < height; row++) {
    plot.push(new Array(samples.length).fill(" "));
  }

  // Plot best fitness
  for (let i = 0; i < samples.length; i++) {
    const normalizedBest = Math.max(0, Math.min(1, (samples[i].bestFitness - minFitness) / range));
    const rowBest = Math.max(0, Math.min(height - 1, height - 1 - Math.floor(normalizedBest * (height - 1))));
    if (plot[rowBest] && plot[rowBest][i] !== undefined) {
      plot[rowBest][i] = "*";
    }

    // Plot average fitness
    const normalizedAvg = Math.max(0, Math.min(1, (samples[i].avgFitness - minFitness) / range));
    const rowAvg = Math.max(0, Math.min(height - 1, height - 1 - Math.floor(normalizedAvg * (height - 1))));
    if (plot[rowAvg] && plot[rowAvg][i] !== undefined && plot[rowAvg][i] === " ") {
      plot[rowAvg][i] = ".";
    }
  }

  // Print plot with Y-axis labels
  for (let row = 0; row < height; row++) {
    const yVal = maxFitness - (row / (height - 1)) * range;
    const label = yVal.toFixed(0).padStart(6);
    console.log(`  ${label} |${plot[row].join("")}|`);
  }

  // X-axis
  console.log(`         +${"-".repeat(samples.length)}+`);
  console.log(`          Gen 0${" ".repeat(Math.max(0, samples.length - 10))}Gen ${history.length - 1}`);
  console.log(`          (* = best fitness, . = avg fitness)`);
}

/**
 * Create progress bar string
 */
function createProgressBar(current: number, total: number, width: number = 30): string {
  const filled = Math.floor((current / total) * width);
  const empty = width - filled;
  return "=".repeat(filled) + "-".repeat(empty);
}

/**
 * Export genetic result to JSON
 */
export function geneticResultToJSON(result: GeneticOptimizationResult): string {
  return JSON.stringify({
    bestStrategy: {
      genes: result.bestStrategy.genes,
      trainingFitness: result.bestStrategy.fitness,
      validationFitness: result.bestStrategy.validationFitness,
    },
    inSampleMetrics: result.inSampleMetrics,
    outOfSampleMetrics: result.outOfSampleMetrics,
    optimization: {
      totalGenerations: result.totalGenerations,
      totalEvaluations: result.totalEvaluations,
      convergedEarly: result.convergedEarly,
      executionTimeMs: result.executionTimeMs,
    },
    config: result.config,
  }, null, 2);
}

/**
 * Export best config for use in .env
 */
export function exportConfigForEnv(result: GeneticOptimizationResult): string {
  const genes = result.bestStrategy.genes;
  return [
    `# Optimized trading parameters (Genetic Algorithm)`,
    `# Generated: ${new Date().toISOString()}`,
    `# Validation PnL: $${result.outOfSampleMetrics.totalPnL.toFixed(2)}`,
    `# Validation Win Rate: ${(result.outOfSampleMetrics.winRate * 100).toFixed(1)}%`,
    ``,
    `BACKTEST_ENTRY_THRESHOLD=${genes.entryThreshold}`,
    `BACKTEST_MAX_ENTRY_PRICE=${genes.maxEntryPrice}`,
    `BACKTEST_STOP_LOSS=${genes.stopLoss}`,
    `BACKTEST_STOP_LOSS_DELAY_MS=${genes.stopLossDelayMs}`,
    `BACKTEST_MAX_SPREAD=${genes.maxSpread}`,
    `BACKTEST_TIME_WINDOW_MINS=${Math.round(genes.timeWindowMs / 60000)}`,
    `BACKTEST_PROFIT_TARGET=${genes.profitTarget}`,
  ].join("\n");
}
