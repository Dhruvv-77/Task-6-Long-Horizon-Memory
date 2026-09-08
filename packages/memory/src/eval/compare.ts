import chalk from 'chalk';
import Table from 'cli-table3';
import { readFileSync, writeFileSync } from 'node:fs';
import type { StrategyMetrics } from '../types.js';

export interface BaselineFile {
  generatedAt: string;
  metrics: StrategyMetrics[];
}

export function readBaseline(path: string): BaselineFile {
  return JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
}

export function writeBaseline(path: string, metrics: StrategyMetrics[]): void {
  const file: BaselineFile = { generatedAt: new Date().toISOString(), metrics };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

function formatDeltaCell(current: number | null, base: number | null, isPollution = false): string {
  if (current === null || base === null) return chalk.gray('n/a');
  const d = current - base;
  const currStr = current.toFixed(2);
  if (Math.abs(d) < 0.0001) {
    return `${currStr} ${chalk.dim('(±0.00)')}`;
  }
  const sign = d > 0 ? '+' : '';
  const deltaStr = `(${sign}${d.toFixed(2)})`;
  const isGood = isPollution ? d < 0 : d > 0;
  return `${currStr} ${isGood ? chalk.green(deltaStr) : chalk.red(deltaStr)}`;
}

export function renderComparison(current: StrategyMetrics[], baseline: BaselineFile): string {
  const table = new Table({
    head: [
      chalk.cyan.bold('Strategy'),
      chalk.cyan.bold('Resume (Δ)'),
      chalk.cyan.bold('Budget (Δ)'),
      chalk.cyan.bold('Recall (Δ)'),
      chalk.cyan.bold('Pollution (Δ)'),
      chalk.cyan.bold('Completion (Δ)'),
    ],
    style: { head: [], border: ['dim'] },
  });

  for (const c of current) {
    const b = baseline.metrics.find((m) => m.strategy === c.strategy);
    if (!b) {
      table.push([chalk.white(c.strategy), 'no baseline entry', '', '', '', '']);
      continue;
    }
    const isTiered = c.strategy === 'tiered_memory';
    const name = isTiered ? chalk.green.bold(c.strategy) : chalk.white(c.strategy);
    table.push([
      name,
      formatDeltaCell(c.resumeCorrectness, b.resumeCorrectness),
      formatDeltaCell(c.contextBudgetAdherence, b.contextBudgetAdherence),
      formatDeltaCell(c.recallAccuracy, b.recallAccuracy),
      formatDeltaCell(c.memoryPollutionRate, b.memoryPollutionRate, true),
      formatDeltaCell(c.completionRate, b.completionRate),
    ]);
  }

  const title = chalk.bold.magenta(`\n📊 Baseline Comparison (Reference timestamp: ${baseline.generatedAt}):\n`);
  return `${title}${table.toString()}`;
}

