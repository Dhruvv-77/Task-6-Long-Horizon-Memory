import chalk from 'chalk';
import Table from 'cli-table3';
import type { MemoryStrategy, ScenarioResult, StrategyMetrics } from '../types.js';

/**
 * Aggregates per-scenario results into the four brief metrics. A metric is
 * null when no scenario in the set exercises it (e.g. recall accuracy over a
 * set with no recall-dependent scenarios).
 */
export function aggregate(strategy: MemoryStrategy, results: ScenarioResult[]): StrategyMetrics {
  const fractionTrue = (vals: (boolean | null)[]): number | null => {
    const xs = vals.filter((v): v is boolean => v !== null);
    if (xs.length === 0) return null;
    return xs.filter(Boolean).length / xs.length;
  };
  return {
    strategy,
    resumeCorrectness: fractionTrue(results.map((r) => r.resumeCorrect)),
    contextBudgetAdherence: fractionTrue(results.map((r) => r.budgetAdherent)) ?? 0,
    recallAccuracy: fractionTrue(results.map((r) => r.recallCorrect)),
    memoryPollutionRate: fractionTrue(results.map((r) => r.polluted)),
    completionRate: results.length > 0 ? results.filter((r) => r.completed).length / results.length : 0,
    scenarios: results.length,
  };
}

export function renderTable(metrics: StrategyMetrics[]): string {
  const table = new Table({
    head: [
      chalk.cyan.bold('Strategy'),
      chalk.cyan.bold('Resume'),
      chalk.cyan.bold('Budget'),
      chalk.cyan.bold('Recall'),
      chalk.cyan.bold('Pollution'),
      chalk.cyan.bold('Completion'),
      chalk.cyan.bold('N'),
    ],
    style: { head: [], border: ['dim'] },
  });

  for (const m of metrics) {
    const isTiered = m.strategy === 'tiered_memory';
    const stratName = isTiered ? chalk.green.bold(m.strategy) : chalk.white(m.strategy);

    const fmtScore = (v: number | null, isPollution = false): string => {
      if (v === null) return chalk.gray('n/a');
      const text = v.toFixed(2);
      if (isPollution) {
        return v === 0 ? chalk.green(text) : chalk.red(text);
      }
      return v >= 1 ? chalk.green(text) : v > 0 ? chalk.yellow(text) : chalk.red(text);
    };

    table.push([
      stratName,
      fmtScore(m.resumeCorrectness),
      fmtScore(m.contextBudgetAdherence),
      fmtScore(m.recallAccuracy),
      fmtScore(m.memoryPollutionRate, true),
      fmtScore(m.completionRate),
      chalk.dim(String(m.scenarios)),
    ]);
  }

  return table.toString();
}

